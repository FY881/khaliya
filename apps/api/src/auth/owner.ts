import type { Env } from "../env";
import { audit } from "../audit";
import { Governor } from "../governor/governor";
import { safeJsonParse } from "../util";
import { stepAt, verifyTotp } from "./totp";

/** Per client IP: 5 failed codes → that IP is locked for 15 minutes (it no longer locks the owner out everywhere). */
export const MAX_FAILS = 5;
/** Global ceiling across all IPs (distributed guessing): 30 fails in 15 minutes → everyone locked for the rest of the window. */
export const GLOBAL_MAX_FAILS = 30;
export const LOCK_MS = 15 * 60 * 1000;

/** Client IP as Cloudflare reports it (CF-Connecting-IP); "unknown" outside Cloudflare (local tests). */
export function clientIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") ?? "").trim().slice(0, 64) || "unknown";
}

/** Governor-state key for one IP's failure counter (IP hashed: raw addresses are never stored). */
export async function ipFailKey(ip: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`khaliya-auth:${ip}`)));
  return `auth.fails.ip.${[...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type Fails = { n: number; since: number };
const locked = (f: Fails, max: number, ms: number) => f.n >= max && ms - f.since < LOCK_MS;
const bump = (f: Fails, ms: number): Fails => (ms - f.since >= LOCK_MS ? { n: 1, since: ms } : { n: f.n + 1, since: f.since });

export type LoginOutcome = { ok: true } | { ok: false; status: 401 | 423 | 503; error: string };

export function authConfigured(env: Env): boolean {
  return !!env.OWNER_TOTP_SECRET && !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 16;
}

export async function sessionEpoch(env: Env): Promise<number> {
  return Number((await new Governor(env).getState("auth.epoch")) ?? "0");
}

/**
 * Verify an owner TOTP code with lockout and replay protection (a time-step can be used once). Used for login and for
 * T4 step-up. Lockout is per client IP (MAX_FAILS / 15 min) plus a higher global ceiling (GLOBAL_MAX_FAILS / 15 min),
 * so one attacker cannot lock the owner out from another network, and many IPs together still cannot brute-force.
 */
export async function checkOwnerCode(env: Env, code: string, purpose: "login" | "step_up", ms = Date.now(), opts: { ip?: string } = {}): Promise<LoginOutcome> {
  if (!authConfigured(env)) return { ok: false, status: 503, error: "owner auth not configured (set OWNER_TOTP_SECRET and SESSION_SECRET)" };
  const gov = new Governor(env);
  const ipKey = await ipFailKey(opts.ip || "unknown");
  const ipFails = safeJsonParse<Fails>(await gov.getState(ipKey)) ?? { n: 0, since: ms };
  const allFails = safeJsonParse<Fails>(await gov.getState("auth.fails")) ?? { n: 0, since: ms };
  if (locked(ipFails, MAX_FAILS, ms) || locked(allFails, GLOBAL_MAX_FAILS, ms)) return { ok: false, status: 423, error: "too many attempts; locked for 15 minutes" };

  const step = await verifyTotp(env.OWNER_TOTP_SECRET!, String(code ?? "").trim(), ms);
  const last = Number((await gov.getState("auth.last_step")) ?? "-1");
  if (step === null || step <= last) {
    const nextIp = bump(ipFails, ms);
    const nextAll = bump(allFails, ms);
    await gov.setState(ipKey, JSON.stringify(nextIp));
    await gov.setState("auth.fails", JSON.stringify(nextAll));
    await audit(env.DB, "anonymous", `auth.${purpose}.fail`, null, { replay: step !== null, n: nextIp.n, n_global: nextAll.n });
    return { ok: false, status: 401, error: step === null ? "invalid code" : "code already used" };
  }
  await gov.setState("auth.last_step", String(step));
  await gov.setState(ipKey, JSON.stringify({ n: 0, since: ms }));
  await audit(env.DB, "owner", `auth.${purpose}.ok`, null, { step: step - stepAt(ms) });
  return { ok: true };
}
