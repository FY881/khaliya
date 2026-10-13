/**
 * P16 must not touch the core: the constitution and the governor are byte-for-byte what they were when the army
 * foundations were written (2026-10-13). If an owner-approved change to these files lands later, update the hashes
 * here in the same commit — the point is that the ARMY work never changes them.
 */
import { describe, expect, it } from "vitest";
import constitutionSrc from "../../src/constitution.ts?raw";
import governorSrc from "../../src/governor/governor.ts?raw";
import quotasSrc from "../../src/governor/quotas.ts?raw";
import { CONSTITUTION } from "../../src/constitution";
import { APPROVAL_MATRIX, requiredApprovals } from "../../src/army/autonomy";

const EXPECTED = {
  "src/constitution.ts": "95a46f6db814336424274acaed7eed426cdb43b3832254d5febdd68ed64cba97",
  "src/governor/governor.ts": "44b0c6075403efcd0dae0f13cb404f56104296e1a82b3f15411e0b8e494f9588",
  // quotas.ts re-snapshotted 2026-10-13: only change since P16 is the STRICTER gemini-flash-latest cap (20/day, Google free limit).
  "src/governor/quotas.ts": "1ff9e1fed9fbd383d1b1c3b889c61098b32d619cb092be367345f154eacfa8ee",
};

async function sha(s: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("core files unchanged by the army", () => {
  it("constitution.ts and governor/* hashes match the pre-P16 snapshot", async () => {
    expect(await sha(constitutionSrc)).toBe(EXPECTED["src/constitution.ts"]);
    expect(await sha(governorSrc)).toBe(EXPECTED["src/governor/governor.ts"]);
    expect(await sha(quotasSrc)).toBe(EXPECTED["src/governor/quotas.ts"]);
  });

  it("constitution is still frozen, v1, 8 articles; army matrix is frozen too", () => {
    expect(Object.isFrozen(CONSTITUTION)).toBe(true);
    expect(CONSTITUTION.version).toBe(1);
    expect(CONSTITUTION.articles.length).toBe(8);
    expect(Object.isFrozen(APPROVAL_MATRIX.money)).toBe(true);
    expect(requiredApprovals("core_change", 4, "L5", { inL5Contract: true }).decision).toBe("forbidden");
  });
});
