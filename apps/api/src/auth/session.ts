import { timingSafeEqual } from "./totp";

export const COOKIE_NAME = "khaliya_session";
export const SESSION_TTL_S = 12 * 60 * 60;

export interface SessionPayload {
  sub: "owner";
  iat: number;
  exp: number;
  ep: number; // session epoch: bump to revoke every session
  sid: string;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

export async function signSession(secret: string, epoch: number, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const sidBytes = new Uint8Array(12);
  crypto.getRandomValues(sidBytes);
  const p: SessionPayload = { sub: "owner", iat: nowS, exp: nowS + SESSION_TTL_S, ep: epoch, sid: b64url(sidBytes) };
  const body = b64url(enc.encode(JSON.stringify(p)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifySession(secret: string, token: string | undefined, epoch: number, nowS = Math.floor(Date.now() / 1000)): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  if (!timingSafeEqual(await hmac(secret, body), sig)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (p.sub !== "owner" || typeof p.exp !== "number" || p.exp < nowS || p.ep !== epoch) return null;
    return p;
  } catch {
    return null;
  }
}

export function cookieHeader(token: string, crossSite: boolean, maxAge = SESSION_TTL_S): string {
  const same = crossSite ? "SameSite=None" : "SameSite=Strict";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; ${same}; Max-Age=${maxAge}`;
}

export function clearCookieHeader(crossSite: boolean): string {
  return cookieHeader("", crossSite, 0);
}
