/** Split a secret holding one or more keys (comma / newline / space separated). */
export function keyList(secret?: string | null): string[] {
  if (!secret) return [];
  return secret
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}
