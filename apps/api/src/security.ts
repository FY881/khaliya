/**
 * HTTP hardening shared by the Worker (index.ts) and the production entry (deploy-entry.ts) — security wave 2026-10-16.
 *
 *  - CONSOLE_HEADERS: strict CSP for the owner console (scripts only from 'self', no inline handlers; inline styles and
 *    Google Fonts allowed because the console uses style attributes and IBM Plex / Inter / JetBrains Mono), HSTS,
 *    nosniff, frame DENY, no-referrer, permissions lock-down.
 *  - API_HEADERS: restrictive defaults on every /api/* response (JSON only: nothing may render or frame it).
 *  - bodyLimitFor(path): request body cap per route class (413 above it).
 */

export const HSTS = "max-age=31536000; includeSubDomains";

export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const CONSOLE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": CONSOLE_CSP,
  "Strict-Transport-Security": HSTS,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
});

export const API_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": HSTS,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
});

/** Request body caps. Every API body is small JSON (largest: an owner brief / attack library / migration batch). */
export const BODY_LIMITS = {
  login: 4 * 1024,
  default: 1024 * 1024,
  large: 4 * 1024 * 1024,
} as const;

const LARGE_PREFIXES = ["/api/studio/briefs", "/api/redteam/", "/api/admin/migrations", "/api/kb/"];

export function bodyLimitFor(path: string): number {
  if (path === "/api/auth/login") return BODY_LIMITS.login;
  if (LARGE_PREFIXES.some((p) => path === p || path.startsWith(p))) return BODY_LIMITS.large;
  return BODY_LIMITS.default;
}

/** Copy a response with extra headers (asset responses can have immutable headers). */
export function withHeaders(res: Response, headers: Readonly<Record<string, string>>): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
