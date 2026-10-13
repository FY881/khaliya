/**
 * Army signing primitives. HMAC-SHA256 via WebCrypto, keyed from SESSION_SECRET with per-purpose domain separation
 * (a passport key can never verify a capability token or a session cookie, and vice versa).
 * Signed string format: `<prefix>.<b64url(canonical JSON body)>.<b64url(sig)>`.
 */
import { timingSafeEqual } from "../auth/totp";
import type { Env } from "../env";
import { canonicalJson } from "../util";

const enc = new TextEncoder();

export class ArmyCryptoError extends Error {
  constructor(public code: "no_secret" | "malformed" | "bad_signature", message: string) {
    super(message);
  }
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function hmacRaw(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export type ArmyPurpose = "passport" | "capability";

/** Purpose key = HMAC(SESSION_SECRET, "khaliya.army.<purpose>.v1"). */
export async function purposeKey(secret: string | undefined, purpose: ArmyPurpose): Promise<Uint8Array> {
  if (!secret || secret.length < 16) throw new ArmyCryptoError("no_secret", "SESSION_SECRET (≥16 chars) is required to sign army documents");
  return hmacRaw(secret, `khaliya.army.${purpose}.v1`);
}

export const armySecret = (env: Pick<Env, "SESSION_SECRET">) => env.SESSION_SECRET;

export async function signDoc(secret: string | undefined, purpose: ArmyPurpose, prefix: string, body: unknown): Promise<string> {
  const key = await purposeKey(secret, purpose);
  const b = b64url(enc.encode(canonicalJson(body)));
  const sig = b64url(await hmacRaw(key, `${prefix}.${b}`));
  return `${prefix}.${b}.${sig}`;
}

/** Verify signature + prefix and return the decoded body. Throws ArmyCryptoError. */
export async function verifyDoc<T>(secret: string | undefined, purpose: ArmyPurpose, prefix: string, token: string): Promise<T> {
  if (typeof token !== "string") throw new ArmyCryptoError("malformed", "token must be a string");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix || !parts[1] || !parts[2]) throw new ArmyCryptoError("malformed", `expected ${prefix}.<body>.<sig>`);
  const key = await purposeKey(secret, purpose);
  const expect = b64url(await hmacRaw(key, `${prefix}.${parts[1]}`));
  if (!timingSafeEqual(expect, parts[2])) throw new ArmyCryptoError("bad_signature", "signature does not match");
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as T;
  } catch {
    throw new ArmyCryptoError("malformed", "body is not JSON");
  }
}
