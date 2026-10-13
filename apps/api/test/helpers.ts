import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { totp } from "../src/auth/totp";
import { resetRouterState } from "../src/llm/router";

/** Read from the test env so tests follow whatever secret the runtime actually has. */
export const totpSecret = () => env.OWNER_TOTP_SECRET!;

/** Fresh D1 + DO storage for each test. */
export async function freshState() {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  resetRouterState();
}

export async function codeAt(offsetSteps = 0): Promise<string> {
  return totp(totpSecret(), Date.now() + offsetSteps * 30_000);
}

/**
 * Log in with the PREVIOUS step's code (allowed by the ±1 window) so a later step-up can use the next one.
 * If a 30 s boundary passes mid-call the -1 code expires; retry once with the current step.
 */
export async function login(offsetSteps = -1): Promise<string> {
  const attempt = async (off: number) =>
    SELF.fetch("https://k.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: await codeAt(off) }),
    });
  let res = await attempt(offsetSteps);
  if (res.status === 401 && offsetSteps < 0) res = await attempt(0);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0];
}

export async function api(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await SELF.fetch(`https://k.test${path}`, {
    method: init.method ?? "GET",
    headers: { cookie, "content-type": "application/json", "x-khaliya": "1" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
