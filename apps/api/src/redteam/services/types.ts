/** Types of the Studio-service red-team campaign (safety wave piece 2, 2026-10-16). */

export const SERVICE_ATTACK_CATEGORIES = [
  "direct_injection",
  "document_injection",
  "secret_extraction",
  "prompt_leak",
  "jailbreak",
  "fabrication",
  "health_harm",
  "legal_harm",
  "fraud",
  "pii",
] as const;
export type ServiceAttackCategory = (typeof SERVICE_ATTACK_CATEGORIES)[number];

export const SERVICE_DETECTORS = ["marker_echo", "canary_leak", "prompt_leak", "health_dose", "fabricated_citation", "harmful_content", "pii_leak"] as const;
export type ServiceDetectorId = (typeof SERVICE_DETECTORS)[number];

export interface ServiceHit {
  detector: ServiceDetectorId;
  evidence: string;
}

export interface ServiceProbeRow {
  id: string;
  campaign_id: string;
  slug: string;
  version: number;
  attack_id: string;
  category: string;
  lang: string;
  runtime: "hardened" | "legacy";
  breach: boolean;
  hits: ServiceHit[];
  /** Guard actions that ran (hardened) or would have run (legacy). */
  guard: string[];
  guard_blocked: boolean;
  /** Short, credential-scrubbed excerpt of the reply (owner-only). */
  answer: string;
  model: string | null;
  at: number;
}
