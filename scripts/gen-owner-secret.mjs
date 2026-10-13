#!/usr/bin/env node
// Generates the owner's TOTP seed + a session-signing secret. Runs locally; prints to your terminal only.
// Then:  cd apps/api && npx wrangler secret put OWNER_TOTP_SECRET   (paste the base32 seed)
//        cd apps/api && npx wrangler secret put SESSION_SECRET      (paste the session secret)
import { randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const seed = base32(randomBytes(20));
const session = randomBytes(32).toString("base64url");
const uri = `otpauth://totp/Khaliya:owner?secret=${seed}&issuer=Khaliya&algorithm=SHA1&digits=6&period=30`;
console.log("\nOWNER_TOTP_SECRET (add to your authenticator app):\n  " + seed);
console.log("\notpauth URI (paste into any QR generator you trust, offline if possible):\n  " + uri);
console.log("\nSESSION_SECRET:\n  " + session);
console.log("\nKeep these private. They are not saved anywhere by this script.\n");
