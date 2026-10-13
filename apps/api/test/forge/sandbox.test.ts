import { describe, expect, it } from "vitest";
import { HARD_LIMITS, resolveLimits, runSandboxed } from "../../src/forge/sandbox";

const run = (code: string, input: unknown = {}, limits = {}, entry = "run") => runSandboxed({ code, entry, input, limits });

describe("forge sandbox: basics", () => {
  it("runs code on a JSON input and returns JSON", async () => {
    const r = await run("function run(x){ return { sum: x.a + x.b, list: [x.a, x.b], s: 'ok' } }", { a: 2, b: 40 });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ sum: 42, list: [2, 40], s: "ok" });
    expect(r.fuelExceeded).toBe(false);
    expect(r.memExceeded).toBe(false);
  });

  it("supports const/arrow entries, undefined -> null, async entries", async () => {
    expect((await run("const run = (x) => x.n * 2", { n: 21 })).value).toBe(42);
    expect((await run("function run(){}")).value).toBeNull();
    expect((await run("async function run(x){ await null; return x.v + 1 }", { v: 1 })).value).toBe(2);
    const rej = await run("async function run(){ throw new Error('nope') }");
    expect(rej.ok).toBe(false);
    expect(rej.error).toContain("nope");
  });

  it("input is deep-frozen and cannot be replaced", async () => {
    const r = await run(
      "function run(){ var a = Object.isFrozen(input) && Object.isFrozen(input.o) && Object.isFrozen(input.o.arr); try { input.o.arr.push(1) } catch (e) {} globalThis.input = 5; return { a: a, len: input.o.arr.length, t: typeof input } }",
      { o: { arr: [1, 2] } },
    );
    expect(r.value).toEqual({ a: true, len: 2, t: "object" });
    const shadow = await run("let input = 1; function run(){ return input }");
    expect(shadow.ok).toBe(false);
    expect(shadow.errorKind).toBe("syntax");
  });

  it("guest errors come back as values, never host exceptions", async () => {
    const t = await run("function run(){ null.x }");
    expect(t).toMatchObject({ ok: false, errorKind: "throw" });
    expect(t.error).toMatch(/TypeError/);
    expect((await run("function run( {")).errorKind).toBe("syntax");
    expect((await run("var run = 3")).errorKind).toBe("bad_entry");
    expect((await run("function run(){}", {}, {}, "input")).errorKind).toBe("bad_entry");
    expect((await run("function run(){}", {}, {}, "a;b")).errorKind).toBe("bad_entry");
  });

  it("enforces size limits on code, input and output", async () => {
    expect((await run("function run(){}" + " ".repeat(200), {}, { maxCodeBytes: 64 })).errorKind).toBe("too_large");
    expect((await run("function run(){}", { s: "x".repeat(500) }, { maxInputBytes: 100 })).errorKind).toBe("too_large");
    const big = await run("function run(){ return 'x'.repeat(5000) }", {}, { maxOutputBytes: 1000 });
    expect(big).toMatchObject({ ok: false, errorKind: "output" });
  });

  it("clamps limits to the hard ceilings", () => {
    const l = resolveLimits({ fuel: 1e9, timeMs: 60_000, memoryBytes: 1e12, maxOutputBytes: 1e9 });
    expect(l.fuel).toBe(HARD_LIMITS.fuel);
    expect(l.timeMs).toBe(2000);
    expect(l.memoryBytes).toBe(HARD_LIMITS.memoryBytes);
    expect(resolveLimits({ timeMs: 1 }).timeMs).toBe(50);
  });
});

describe("forge sandbox: escapes are blocked", () => {
  it("has no network, timers, modules or host objects", async () => {
    const r = await run(`function run(){
      var names = ["fetch","XMLHttpRequest","WebSocket","setTimeout","setInterval","require","Deno","caches","crypto","navigator","WebAssembly","importScripts","console","scheduler","Request","Response","std","os","Bun"];
      var out = {};
      names.forEach(function(n){ out[n] = typeof globalThis[n]; });
      return out;
    }`);
    expect(r.ok).toBe(true);
    for (const v of Object.values(r.value as Record<string, string>)) expect(v).toBe("undefined");
  });

  it("constructor / Function / indirect-eval tricks only reach the guest realm", async () => {
    const r = await run(`function run(){
      var F = (function(){}).constructor;
      var g1 = F("return this")();
      var g2 = this && this.constructor ? this.constructor.constructor("return typeof fetch")() : "undefined";
      var g3 = (0, eval)("typeof setTimeout");
      var g4 = [].constructor.constructor("return typeof require")();
      return { same: g1 === globalThis, g2: g2, g3: g3, g4: g4, keys: Object.getOwnPropertyNames(g1).filter(function(k){ return /fetch|caches|binding|DB/.test(k) }) };
    }`);
    expect(r.value).toEqual({ same: true, g2: "undefined", g3: "undefined", g4: "undefined", keys: [] });
  });

  it("dynamic import fails (no module loader)", async () => {
    const r = await run("async function run(){ return await import('cloudflare:workers') }");
    expect(r.ok).toBe(false);
  });

  it("tampering with guest globals cannot hijack the host-held result runner", async () => {
    const r = await run(`
      JSON.stringify = function(){ return 12345 };
      Promise.resolve = function(){ return { then: function(){} } };
      globalThis.__k_run = function(){ return "pwned" };
      function run(){ delete globalThis.input; return { inputAlive: typeof input, v: [1, "two"] } }`);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ inputAlive: "object", v: [1, "two"] });
    const asyncTamper = await run("Promise.prototype.then = function(){ return 1 }; async function run(){ return 5 }");
    expect(asyncTamper.ok === false || asyncTamper.value === 5).toBe(true);
  });

  it("prototype pollution stays inside the run (fresh realm every call)", async () => {
    const a = await run("function run(){ Object.prototype.pwned = 1; Array.prototype.push = null; return ({}).pwned }");
    expect(a.value).toBe(1);
    const b = await run("function run(){ var x = []; x.push(1); return { p: ({}).pwned === undefined, n: x.length } }");
    expect(b.value).toEqual({ p: true, n: 1 });
    expect((Object.prototype as any).pwned).toBeUndefined();
  });

  it("does not leak into the host global", async () => {
    await run("function run(){ globalThis.leak = 1; var leak2 = 2; return 0 }");
    expect((globalThis as any).leak).toBeUndefined();
    expect((globalThis as any).input).toBeUndefined();
    expect((globalThis as any).__k_run).toBeUndefined();
  });
});

describe("forge sandbox: budgets", () => {
  it("interrupts an infinite loop (fuel)", async () => {
    const r = await run("function run(){ while(true){} }", {}, { fuel: 50 });
    expect(r).toMatchObject({ ok: false, errorKind: "fuel", fuelExceeded: true });
    expect(r.fuelUsed).toBeGreaterThanOrEqual(50);
  });

  it("the interrupt cannot be caught by the guest", async () => {
    const r = await run("function run(){ for(;;){ try { for(;;){} } catch (e) {} } }", {}, { fuel: 50 });
    expect(r).toMatchObject({ ok: false, fuelExceeded: true });
  });

  it("interrupts busy work inside a promise job", async () => {
    const r = await run("async function run(){ await null; for(;;){} }", {}, { fuel: 50 });
    expect(r).toMatchObject({ ok: false, fuelExceeded: true });
  });

  it("stops a memory bomb", async () => {
    const r = await run("function run(){ var a = []; for(;;) a.push(new Array(10000).fill(a.length)); }", {}, { memoryBytes: 2 * 1024 * 1024, fuel: 20000 });
    expect(r).toMatchObject({ ok: false, errorKind: "memory", memExceeded: true });
    const s = await run("function run(){ var s = 'x'; for(;;) s = s + s; }", {}, { memoryBytes: 2 * 1024 * 1024, fuel: 20000 });
    expect(s.ok).toBe(false);
    expect(s.memExceeded || s.errorKind === "throw").toBe(true);
    // the engine is still healthy afterwards
    expect((await run("function run(){ return 7 }")).value).toBe(7);
  });

  it("a huge single allocation hits the instance memory ceiling, not the isolate", async () => {
    const r = await run("function run(){ return 'x'.repeat(200 * 1024 * 1024).length }", {}, { fuel: 20000 });
    expect(r).toMatchObject({ ok: false, errorKind: "memory", memExceeded: true });
  });

  it("catastrophic regex backtracking is interrupted", async () => {
    const r = await run("function run(){ return /(a+)+$/.test('a'.repeat(40) + 'b') }", {}, { fuel: 100 });
    expect(r).toMatchObject({ ok: false, fuelExceeded: true });
  });

  it("stops runaway recursion without crashing the host", async () => {
    const r = await run("function f(n){ return f(n + 1) + 1 } function run(){ return f(0) }", {}, { fuel: 20000 });
    expect(r.ok).toBe(false);
    expect(["stack", "memory"]).toContain(r.errorKind);
  });

  it("finishes honest work within budget and reports fuel", async () => {
    const r = await run("function run(x){ var s = 0; for (var i = 0; i < x.n; i++) s += i; return s }", { n: 100000 }, { fuel: 5000 });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(4999950000);
    expect(r.fuelUsed).toBeGreaterThan(0);
  });
});

describe("forge sandbox: determinism", () => {
  const code =
    "function run(){ return { r: [rand(), rand(), rand()], m: Math.random === rand, now: Date.now(), d: new Date().getTime(), fixed: new Date(86400000).getTime() } }";
  it("seeded rand(): same seed same sequence, different seed different", async () => {
    const a = await run(code, {}, { seed: 42 });
    const b = await run(code, {}, { seed: 42 });
    const c = await run(code, {}, { seed: 43 });
    expect(a.value).toEqual(b.value);
    expect((a.value as any).r).not.toEqual((c.value as any).r);
    expect(a.value).toMatchObject({ m: true, now: 0, d: 0, fixed: 86400000 });
    for (const x of (a.value as any).r) expect(x >= 0 && x < 1).toBe(true);
  });
});
