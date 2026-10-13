/**
 * Forge sandbox: run UNTRUSTED JavaScript inside QuickJS compiled to WebAssembly, inside the Worker.
 *
 * Isolation model
 *  - The guest is a separate JS engine (QuickJS) living in WASM linear memory. It shares no objects with
 *    the host. The only things that cross the boundary are: one JSON string in (the input) and one JSON
 *    string out (the result). No host function is ever exposed to the guest.
 *  - The guest context has no fetch, no timers, no console, no modules (no std/os), no Worker bindings.
 *  - `input` is a deep-frozen, non-configurable global; `rand()` is a deterministic seeded PRNG written in
 *    guest JS (Math.random is replaced by it); `Date` is frozen at epoch 0 so runs are reproducible.
 *
 * Budgets
 *  - fuel: QuickJS calls the interrupt handler roughly every 10k bytecode ops (loop back-edges and calls).
 *    Each call costs one unit of fuel. This is the PRIMARY CPU budget, because inside workerd the clock does
 *    not advance during synchronous execution (Spectre mitigation), so wall-time checks alone cannot stop a
 *    `while(true){}`. A wall-clock deadline (timeMs) is enforced too, for environments where time moves.
 *  - memory, three layers: (1) the whole QuickJS instance's WASM linear memory has a hard maximum
 *    (WASM_MEMORY_MAX_BYTES) so the guest can never push the isolate toward the Worker's 128 MB limit:
 *    malloc returns NULL and QuickJS throws "out of memory" inside the guest; (2) QuickJS's malloc limit is
 *    set to memoryBytes (in this emscripten build it undercounts big blocks, so it mainly catches many
 *    small allocations); (3) linear-memory growth during the run beyond memoryBytes is checked at every
 *    interrupt tick and again at the end (the result is then discarded with memExceeded). The per-run
 *    byte budget is therefore approximate; the instance ceiling is exact.
 *  - stackBytes: max guest stack (deep recursion → RangeError, never a host crash).
 *  - maxOutputBytes: UTF-8 size cap on the JSON result. maxCodeBytes/maxInputBytes: size caps going in.
 *
 * The WASM module is imported as a pre-compiled WebAssembly.Module (workerd forbids compiling wasm from
 * bytes at runtime), instantiated once per isolate, and each run gets its own QuickJS runtime + context.
 */
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSWASMModule, type QuickJSHandle } from "quickjs-emscripten-core";
import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
// Pre-compiled by wrangler / the vitest workers pool (CompiledWasm module rule). The specifier must END in
// ".wasm" for wrangler's bundler to pick the rule, and the package's exports map hides dist/, hence the
// relative path. It always points at the SAME package version as the JS glue above (they must match).
import quickjsWasm from "../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";

export interface SandboxLimits {
  /** Interrupt-handler ticks (~10k guest ops each). Primary CPU budget. */
  fuel?: number;
  /** Wall-clock deadline in ms (secondary; clamped to 50..2000). */
  timeMs?: number;
  /** QuickJS heap limit in bytes (clamped to 1 MiB..64 MiB). */
  memoryBytes?: number;
  /** Max guest stack in bytes (clamped to 64 KiB..1 MiB). */
  stackBytes?: number;
  /** Max UTF-8 bytes of the JSON result. */
  maxOutputBytes?: number;
  maxCodeBytes?: number;
  maxInputBytes?: number;
  /** Seed for the guest's rand(). Same seed + same input ⇒ same output. */
  seed?: number;
}

export interface SandboxRequest {
  code: string;
  /** Name of a global function (declared by `code`) that is called as entry(input). */
  entry: string;
  input?: unknown;
  limits?: SandboxLimits;
}

export type SandboxErrorKind = "fuel" | "time" | "memory" | "stack" | "output" | "too_large" | "syntax" | "throw" | "bad_entry" | "bad_result" | "internal";

export interface SandboxResult {
  ok: boolean;
  /** JSON value returned by the entry function (null for undefined). Present iff ok. */
  value?: unknown;
  /** Error message. Present iff !ok. */
  error?: string;
  errorKind?: SandboxErrorKind;
  ms: number;
  /** Interrupt ticks consumed. */
  fuelUsed: number;
  fuelExceeded: boolean;
  memExceeded: boolean;
  outputBytes: number;
}

export const DEFAULT_LIMITS: Required<SandboxLimits> = Object.freeze({
  fuel: 2_000,
  timeMs: 1_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  maxOutputBytes: 64 * 1024,
  maxCodeBytes: 64 * 1024,
  maxInputBytes: 64 * 1024,
  seed: 1,
});

/** Hard ceilings no caller can exceed (a forged tool's spec can only lower these). */
export const HARD_LIMITS: Required<SandboxLimits> = Object.freeze({
  fuel: 20_000,
  timeMs: 2_000,
  memoryBytes: 40 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  maxOutputBytes: 256 * 1024,
  maxCodeBytes: 128 * 1024,
  maxInputBytes: 256 * 1024,
  seed: 0xffffffff,
});

const clamp = (v: number | undefined, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : d;

export function resolveLimits(l: SandboxLimits = {}): Required<SandboxLimits> {
  const D = DEFAULT_LIMITS;
  const H = HARD_LIMITS;
  return {
    fuel: clamp(l.fuel, 1, H.fuel, D.fuel),
    timeMs: clamp(l.timeMs, 50, H.timeMs, D.timeMs),
    memoryBytes: clamp(l.memoryBytes, 1024 * 1024, H.memoryBytes, D.memoryBytes),
    stackBytes: clamp(l.stackBytes, 64 * 1024, H.stackBytes, D.stackBytes),
    maxOutputBytes: clamp(l.maxOutputBytes, 16, H.maxOutputBytes, D.maxOutputBytes),
    maxCodeBytes: clamp(l.maxCodeBytes, 16, H.maxCodeBytes, D.maxCodeBytes),
    maxInputBytes: clamp(l.maxInputBytes, 2, H.maxInputBytes, D.maxInputBytes),
    seed: clamp(l.seed, 0, H.seed, D.seed),
  };
}

const ENTRY_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const RESERVED_ENTRIES = new Set(["input", "rand", "eval", "Function", "globalThis", "this", "undefined", "arguments"]);

/**
 * Ceiling on the WASM linear memory of the whole QuickJS instance (all runs share it, one at a time).
 * This is the hard backstop that keeps a guest from growing the isolate toward the Worker's 128 MB limit:
 * when the guest asks for more, malloc returns NULL and QuickJS throws "out of memory" inside the guest.
 * (QuickJS's own malloc limit in this build undercounts large blocks, so it cannot be the only guard.)
 */
export const WASM_MEMORY_MAX_BYTES = 64 * 1024 * 1024;
/** After a run, an instance whose linear memory grew past this is dropped so the isolate gets it back. */
const WASM_RECYCLE_BYTES = 40 * 1024 * 1024;
const PAGE = 64 * 1024;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

/** The QuickJS WASM module, instantiated once per isolate. */
export function getQuickJS(): Promise<QuickJSWASMModule> {
  if (!modulePromise) {
    wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: WASM_MEMORY_MAX_BYTES / PAGE });
    const variant = newVariant(baseVariant, { wasmModule: quickjsWasm as WebAssembly.Module, wasmMemory });
    modulePromise = newQuickJSWASMModuleFromVariant(variant).catch((e) => {
      modulePromise = null;
      throw e;
    });
  }
  return modulePromise;
}

/** Drop the cached module (used after a host-side fault so the next run starts from clean WASM memory). */
export function resetQuickJS() {
  modulePromise = null;
  wasmMemory = null;
}

/** Current size of the instance's linear memory (bytes), for diagnostics. */
export const wasmMemoryBytes = () => wasmMemory?.buffer.byteLength ?? 0;

/**
 * Guest prelude. Runs before the untrusted code. `input` and `rand` are defined non-writable and
 * non-configurable on globalThis (so `let input` at global scope is a SyntaxError). Note: this is a
 * convenience, not a security boundary: everything inside the guest realm is guest-controlled anyway; the
 * boundary is host ↔ WASM, and the result runner is held by the host only.
 */
const PRELUDE = `(function () {
  "use strict";
  var src = globalThis.__k_in; delete globalThis.__k_in;
  var seed = globalThis.__k_seed >>> 0; delete globalThis.__k_seed;
  function deepFreeze(o) {
    if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); }
    return o;
  }
  var input = deepFreeze(JSON.parse(src));
  var s = seed;
  function rand() { // mulberry32
    s = (s + 0x6D2B79F5) >>> 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  var stringify = JSON.stringify;
  var isArr = Array.isArray;
  function def(k, v) { Object.defineProperty(globalThis, k, { value: v, writable: false, configurable: false, enumerable: false }); }
  def("input", input);
  def("rand", rand);
  Math.random = rand;
  var RD = Date;
  function D() {
    if (!new.target) return new RD(0).toString();
    return arguments.length ? new (Function.prototype.bind.apply(RD, [null].concat([].slice.call(arguments))))() : new RD(0);
  }
  D.now = function () { return 0; };
  D.UTC = RD.UTC; D.parse = RD.parse; D.prototype = RD.prototype;
  globalThis.Date = D;
  function out(v) { var j = stringify(v === undefined ? null : v); return j === undefined ? "null" : j; }
  // The runner is handed back to the HOST as this script's completion value. It is never reachable from
  // guest code, so redefining globals (JSON, Promise, input, …) cannot hijack how the result is produced.
  var P = Promise;
  return function (f) {
    if (typeof f !== "function") throw new TypeError("__K_BAD_ENTRY");
    var v = f(input);
    if (v && typeof v === "object" && typeof v.then === "function") return P.resolve(v).then(out);
    return out(v);
  };
})();`;

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).length;
const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

function classify(msg: string, state: { fuelExceeded: boolean; timeExceeded: boolean; memTripped: boolean }): SandboxErrorKind {
  if (state.fuelExceeded) return "fuel";
  if (state.timeExceeded) return "time";
  if (state.memTripped) return "memory";
  if (/out of memory/i.test(msg)) return "memory";
  if (/stack overflow|call stack size exceeded/i.test(msg)) return "stack";
  if (/__K_BAD_ENTRY/.test(msg)) return "bad_entry";
  if (/^SyntaxError/.test(msg)) return "syntax";
  return "throw";
}

/**
 * Run untrusted `code` and call `entry(input)` inside a fresh QuickJS runtime.
 * Never throws for guest misbehaviour: every failure comes back as {ok:false, errorKind}.
 */
export async function runSandboxed(req: SandboxRequest): Promise<SandboxResult> {
  const L = resolveLimits(req.limits);
  const t0 = nowMs();
  const base = { ms: 0, fuelUsed: 0, fuelExceeded: false, memExceeded: false, outputBytes: 0 };
  const fail = (errorKind: SandboxErrorKind, error: string, extra: Partial<SandboxResult> = {}): SandboxResult => ({
    ...base,
    ...extra,
    ok: false,
    error,
    errorKind,
    ms: Math.round((nowMs() - t0) * 100) / 100,
  });

  if (typeof req.code !== "string" || !req.code.trim()) return fail("too_large", "code must be a non-empty string");
  if (byteLen(req.code) > L.maxCodeBytes) return fail("too_large", `code larger than ${L.maxCodeBytes} bytes`);
  if (typeof req.entry !== "string" || !ENTRY_RE.test(req.entry) || RESERVED_ENTRIES.has(req.entry)) return fail("bad_entry", "entry must be a plain identifier");
  let inputJson: string;
  try {
    inputJson = JSON.stringify(req.input === undefined ? null : req.input) ?? "null";
  } catch {
    return fail("too_large", "input is not JSON-serialisable");
  }
  if (byteLen(inputJson) > L.maxInputBytes) return fail("too_large", `input larger than ${L.maxInputBytes} bytes`);

  const QuickJS = await getQuickJS();
  const rt = QuickJS.newRuntime();
  const state = { fuel: 0, fuelExceeded: false, timeExceeded: false, memTripped: false };
  const deadline = Date.now() + L.timeMs;
  const memStart = wasmMemoryBytes();
  rt.setMemoryLimit(L.memoryBytes);
  rt.setMaxStackSize(L.stackBytes);
  rt.setInterruptHandler(() => {
    state.fuel++;
    if (state.fuel > L.fuel) return (state.fuelExceeded = true);
    if (Date.now() > deadline) return (state.timeExceeded = true);
    // Linear-memory growth during this run beyond the run's budget (coarse: checked at interrupt ticks).
    if (wasmMemoryBytes() - memStart > L.memoryBytes) return (state.memTripped = true);
    return false;
  });
  const ctx = rt.newContext();
  let runner: QuickJSHandle | null = null;
  const snap = (): Partial<SandboxResult> => ({
    fuelUsed: Math.min(state.fuel, L.fuel + 1),
    fuelExceeded: state.fuelExceeded,
    memExceeded: state.memTripped,
  });
  const errOf = (h: QuickJSHandle): string => {
    try {
      const d = ctx.dump(h);
      if (d && typeof d === "object") return `${d.name ?? "Error"}: ${d.message ?? JSON.stringify(d)}`.slice(0, 500);
      return String(d).slice(0, 500);
    } catch {
      return "guest error";
    } finally {
      h.dispose();
    }
  };
  const guestFail = (msg: string) => {
    const kind = classify(msg, state);
    const m = kind === "fuel" ? "fuel budget exceeded" : kind === "time" ? "time budget exceeded" : kind === "memory" && state.memTripped ? "memory budget exceeded" : msg;
    return fail(kind, m, {
      ...snap(),
      memExceeded: kind === "memory",
    });
  };

  try {
    // Hand the input and seed over as plain strings/numbers (no host functions are ever installed).
    const inH = ctx.newString(inputJson);
    ctx.setProp(ctx.global, "__k_in", inH);
    inH.dispose();
    const seedH = ctx.newNumber(L.seed);
    ctx.setProp(ctx.global, "__k_seed", seedH);
    seedH.dispose();

    const pre = ctx.evalCode(PRELUDE, "prelude.js");
    if (pre.error) return guestFail(errOf(pre.error));
    runner = pre.value;

    const user = ctx.evalCode(req.code, "tool.js");
    if (user.error) return guestFail(errOf(user.error));
    user.value.dispose();

    const ent = ctx.evalCode(`typeof ${req.entry} === "function" ? ${req.entry} : undefined`, "entry.js");
    if (ent.error) return guestFail(errOf(ent.error));
    const call = ctx.callFunction(runner, ctx.undefined, ent.value);
    ent.value.dispose();
    if (call.error) return guestFail(errOf(call.error));

    let outH: QuickJSHandle = call.value;
    if (ctx.typeof(outH) !== "string") {
      if (ctx.typeof(outH) !== "object") {
        outH.dispose();
        return fail("bad_result", "result is not JSON", snap());
      }
      // async entry: drain the job queue (still under fuel/memory limits), then read the promise.
      const jobs = rt.executePendingJobs(10_000);
      if (jobs.error) {
        outH.dispose();
        return guestFail(errOf(jobs.error));
      }
      const st = ctx.getPromiseState(outH);
      if (st.type === "fulfilled" && st.notAPromise) {
        outH.dispose();
        return fail("bad_result", "result is not JSON", snap());
      }
      outH.dispose();
      if (st.type === "pending") return fail("bad_result", "promise never settled", snap());
      if (st.type === "rejected") return guestFail(errOf(st.error));
      outH = st.value;
      if (ctx.typeof(outH) !== "string") {
        outH.dispose();
        return fail("bad_result", "result is not JSON", snap());
      }
    }
    const json = ctx.getString(outH);
    outH.dispose();
    if (wasmMemoryBytes() - memStart > L.memoryBytes) {
      state.memTripped = true;
      return fail("memory", "memory budget exceeded", snap());
    }
    const outputBytes = byteLen(json);
    if (outputBytes > L.maxOutputBytes) return fail("output", `output larger than ${L.maxOutputBytes} bytes`, { ...snap(), outputBytes });
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return fail("bad_result", "result is not JSON", snap());
    }
    return { ...base, ...snap(), ok: true, value, outputBytes, ms: Math.round((nowMs() - t0) * 100) / 100 } as SandboxResult;
  } catch (e) {
    // A host-side fault (should not happen). Start the next run from a fresh WASM instance.
    resetQuickJS();
    const msg = String((e as Error)?.message ?? e);
    if (/out of memory/i.test(msg)) return fail("memory", msg.slice(0, 300), { ...snap(), memExceeded: true });
    return fail("internal", msg.slice(0, 300), snap());
  } finally {
    try {
      runner?.dispose();
      ctx.dispose();
      rt.dispose();
      if (wasmMemoryBytes() > WASM_RECYCLE_BYTES) resetQuickJS();
    } catch {
      // A runtime that hit OOM can fail its GC assertions on dispose; drop the whole instance instead.
      resetQuickJS();
    }
  }
}
