import type { Env } from "../env";
import { audit } from "../audit";
import { Governor } from "../governor/governor";
import { safeJsonParse } from "../util";
import { stepAt, verifyTotp } from "./totp";

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export type LoginOutcome = { ok: true } | { ok: false; status: 401 | 423 | 503; error: string };

export function authConfigured(env: Env): boolean {
  return !!env.OWNER_TOTP_SECRET && !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 16;
}

export async function sessionEpoch(env: Env): Promise<number> {
  return Number((await new Governor(env).getState("auth.epoch")) ?? "0");
}

/**
 * Verify an owner TOTP code with lockout (5 fails / 15 min) and replay protection
 * (a time-step can be used once). Used for login and for T4 step-up.
 */
export async function checkOwnerCode(env: Env, code: string, purpose: "login" | "step_up", ms = Date.now()): Promise<LoginOutcome> {
  if (!authConfigured(env)) return { ok: false, status: 503, error: "owner auth not configured (set OWNER_TOTP_SECRET and SESSION_SECRET)" };
  const gov = new Governor(env);
  const fails = safeJsonParse<{ n: number; since: number }>(await gov.getState("auth.fails")) ?? { n: 0, since: ms };
  if (fails.n >= MAX_FAILS && ms - fails.since < LOCK_MS) return { ok: false, status: 423, error: "too many attempts; locked for 15 minutes" };

  const step = await verifyTotp(env.OWNER_TOTP_SECRET!, String(code ?? "").trim(), ms);
  const last = Number((await gov.getState("auth.last_step")) ?? "-1");
  if (step === null || step <= last) {
    const reset = ms - fails.since >= LOCK_MS;
    const next = { n: reset ? 1 : fails.n + 1, since: reset ? ms : fails.since };
    await gov.setState("auth.fails", JSON.stringify(next));
    await audit(env.DB, "anonymous", `auth.${purpose}.fail`, null, { replay: step !== null, n: next.n });
    return { ok: false, status: 401, error: step === null ? "invalid code" : "code already used" };
  }
  await gov.setState("auth.last_step", String(step));
  await gov.setState("auth.fails", JSON.stringify({ n: 0, since: ms }));
  await audit(env.DB, "owner", `auth.${purpose}.ok`, null, { step: step - stepAt(ms) });
  return { ok: true };
}
