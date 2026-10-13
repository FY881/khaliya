// Promotion gate, canary routing and rollback decision for evolved genomes.
import { hashSeed, mulberry32 } from "./bandit";
import { wilsonLower, winRate } from "./rating";

export interface GateInput {
  wins: number;
  losses: number;
  draws: number;
  safetyCandidate: number; // higher = safer
  safetyChampion: number;
  costCandidate: number;
  costChampion: number;
}
export interface GateOptions {
  minMatches: number;
  minWinRate: number;
  maxCostIncrease: number; // relative, e.g. 0.25 = +25%
}
export interface GateResult {
  pass: boolean;
  reasons: string[];
  winRate: number;
  wilsonLower: number;
}

export const DEFAULT_GATE: GateOptions = { minMatches: 8, minWinRate: 0.55, maxCostIncrease: 0.25 };

export function promotionGate(input: GateInput, opts: Partial<GateOptions> = {}): GateResult {
  const o = { ...DEFAULT_GATE, ...opts };
  const reasons: string[] = [];
  const { wins, losses, draws } = input;
  const n = wins + losses + draws;
  const rate = winRate(wins, losses, draws);
  const lower = wilsonLower(wins + draws / 2, n);

  if ([wins, losses, draws].some((x) => !Number.isFinite(x) || x < 0)) reasons.push("invalid match counts");
  if (n < o.minMatches) reasons.push(`too few matches: ${n} < ${o.minMatches}`);
  if (rate < o.minWinRate) reasons.push(`win rate ${rate.toFixed(3)} < ${o.minWinRate}`);
  if (!(lower > 0.5)) reasons.push(`wilson lower bound ${lower.toFixed(3)} <= 0.5`);
  if (!Number.isFinite(input.safetyCandidate) || input.safetyCandidate < input.safetyChampion)
    reasons.push(`safety regression: ${input.safetyCandidate} < ${input.safetyChampion}`);

  const { costCandidate: cc, costChampion: ch } = input;
  if (!Number.isFinite(cc) || cc < 0) reasons.push("invalid candidate cost");
  else if (ch > 0) {
    const inc = (cc - ch) / ch;
    if (inc > o.maxCostIncrease) reasons.push(`cost increase ${(inc * 100).toFixed(1)}% > ${(o.maxCostIncrease * 100).toFixed(1)}%`);
  } else if (cc > 0) reasons.push("cost increase from zero-cost champion");

  return { pass: reasons.length === 0, reasons, winRate: rate, wilsonLower: lower };
}

/** Deterministic canary assignment: same seed → same route. */
export function canaryRoute(seed: number | string, pct = 0.1): boolean {
  if (!(pct > 0)) return false;
  if (pct >= 1) return true;
  return mulberry32(hashSeed(seed))() < pct;
}

export interface RollbackInput {
  canaryScore: number;
  championScore: number;
  n: number;
  minN?: number;
  maxDrop?: number; // absolute score drop tolerated
}

/** Roll back once enough canary samples show a drop larger than maxDrop. */
export function shouldRollback({ canaryScore, championScore, n, minN = 5, maxDrop = 0.05 }: RollbackInput): boolean {
  if (!Number.isFinite(canaryScore)) return n >= minN;
  if (n < minN) return false;
  return championScore - canaryScore > maxDrop;
}
