// Tournament scheduling and aggregation for candidate-vs-champion/peer evaluation.
//
// Every pairing is played twice on the same item with positions swapped (A/B then B/A), so a judge's
// position bias cancels out. Items authored by the candidate's own lineage are excluded (no one is
// graded on questions they wrote). Aggregation is one Glicko-2 rating period using rating.ts.
import { hashSeed, mulberry32, type Rng } from "./bandit";
import { newPlayer, update, type Glicko2Player, type Glicko2Result } from "./rating";

export interface Match {
  id: string; // `${pairKey}#0` | `${pairKey}#1`
  pairKey: string; // `${itemId}|${candidate}|${opponent}`
  itemId: string;
  a: string; // shown first
  b: string; // shown second
  swapped: boolean; // false: candidate is A; true: candidate is B
}

export interface ScheduleOptions {
  /** Lineage(s) whose authored items are excluded (normally the candidate's lineage). */
  excludeAuthoredByLineage?: string | string[];
  /** itemId → authoring lineage id. Items without an entry are treated as neutral. */
  authorsByItem?: Record<string, string | undefined>;
  seed?: number | string;
  /** Upper bound on matches (rounded down to whole swapped pairs). */
  maxMatches?: number;
}

function shuffled<T>(rng: Rng, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Deterministic schedule. Order: every champion pair first (items in seeded order), then peer pairs
 * round-robin by item (seeded), so a `maxMatches` cap keeps champion coverage first and spreads
 * peers across items. Each pair contributes two consecutive matches with positions swapped.
 */
export function schedule(
  candidateId: string,
  championId: string | null | undefined,
  peers: string[],
  itemIds: string[],
  opts: ScheduleOptions = {},
): Match[] {
  const excluded = new Set(
    opts.excludeAuthoredByLineage === undefined
      ? []
      : Array.isArray(opts.excludeAuthoredByLineage)
        ? opts.excludeAuthoredByLineage
        : [opts.excludeAuthoredByLineage],
  );
  const authors = opts.authorsByItem ?? {};
  const rng = mulberry32(hashSeed(opts.seed ?? `${candidateId}|${championId ?? ""}`));
  const items = shuffled(
    rng,
    [...new Set(itemIds)].sort().filter((i) => {
      const au = authors[i];
      return !(au !== undefined && excluded.has(au));
    }),
  );
  const champ = championId && championId !== candidateId ? championId : undefined;
  const peerIds = [...new Set(peers)].filter((p) => p !== candidateId && p !== champ).sort();

  const pairs: { itemId: string; opp: string }[] = [];
  if (champ) for (const itemId of items) pairs.push({ itemId, opp: champ });
  if (peerIds.length) {
    const order = shuffled(rng, peerIds);
    let k = 0;
    for (const itemId of items) {
      // rotate the peer order per item so a cap spreads opponents evenly
      for (let j = 0; j < order.length; j++) pairs.push({ itemId, opp: order[(j + k) % order.length]! });
      k++;
    }
  }

  const maxPairs = opts.maxMatches === undefined ? Infinity : Math.max(0, Math.floor(opts.maxMatches / 2));
  const out: Match[] = [];
  for (const { itemId, opp } of pairs.slice(0, maxPairs)) {
    const pairKey = `${itemId}|${candidateId}|${opp}`;
    // randomise which orientation is played first, but always play both
    const candFirst = rng() < 0.5;
    const m0: Match = { id: `${pairKey}#0`, pairKey, itemId, a: candidateId, b: opp, swapped: false };
    const m1: Match = { id: `${pairKey}#1`, pairKey, itemId, a: opp, b: candidateId, swapped: true };
    out.push(...(candFirst ? [m0, m1] : [m1, m0]));
  }
  return out;
}

export interface MatchResult {
  a: string;
  b: string;
  /** Score for `a`: 1 win, 0.5 draw, 0 loss. */
  score: 0 | 0.5 | 1;
  pairKey?: string;
}

export interface Record3 {
  wins: number;
  losses: number;
  draws: number;
  games: number;
}

export interface AggregateOptions {
  tau?: number;
  /** Apply Glicko-2 RD inflation to rated players who played no games this period (default false). */
  inflateIdle?: boolean;
}

export interface AggregateResult {
  ratings: Record<string, Glicko2Player>;
  records: Record<string, Record3>;
  /** pairKeys of position-swapped pairs whose two orientations gave different outcomes (sign of position bias). */
  inconsistentPairs: string[];
}

const blank = (): Record3 => ({ wins: 0, losses: 0, draws: 0, games: 0 });

/**
 * One Glicko-2 rating period over all results. Opponent ratings are taken from the PRE-period
 * snapshot, so the outcome does not depend on result order. Players missing from `ratings`
 * start at the Glicko-2 defaults. Invalid results (self-play, bad score) are ignored.
 */
export function aggregate(
  matchResults: MatchResult[],
  ratings: Record<string, Partial<Glicko2Player>> = {},
  opts: AggregateOptions = {},
): AggregateResult {
  const pre: Record<string, Glicko2Player> = {};
  for (const [id, p] of Object.entries(ratings)) pre[id] = newPlayer(p);
  const valid = matchResults.filter((m) => m.a && m.b && m.a !== m.b && (m.score === 0 || m.score === 0.5 || m.score === 1));
  for (const m of valid) {
    pre[m.a] ??= newPlayer();
    pre[m.b] ??= newPlayer();
  }

  const games: Record<string, Glicko2Result[]> = {};
  const records: Record<string, Record3> = {};
  const tally = (id: string, s: number) => {
    const r = (records[id] ??= blank());
    r.games++;
    if (s === 1) r.wins++;
    else if (s === 0) r.losses++;
    else r.draws++;
  };
  for (const m of valid) {
    const sb = (1 - m.score) as 0 | 0.5 | 1;
    (games[m.a] ??= []).push({ opp: { r: pre[m.b]!.r, rd: pre[m.b]!.rd }, score: m.score });
    (games[m.b] ??= []).push({ opp: { r: pre[m.a]!.r, rd: pre[m.a]!.rd }, score: sb });
    tally(m.a, m.score);
    tally(m.b, sb);
  }

  const out: Record<string, Glicko2Player> = {};
  for (const id of Object.keys(pre).sort()) {
    const g = games[id];
    if (g && g.length) out[id] = update(pre[id]!, g, opts.tau);
    else out[id] = opts.inflateIdle ? update(pre[id]!, [], opts.tau) : { ...pre[id]! };
    records[id] ??= blank();
  }

  // position consistency: group by pairKey; a pair is inconsistent when the same player does not
  // come out ahead (or level) in both orientations.
  const byPair = new Map<string, MatchResult[]>();
  for (const m of valid) if (m.pairKey) byPair.set(m.pairKey, [...(byPair.get(m.pairKey) ?? []), m]);
  const inconsistentPairs: string[] = [];
  for (const [key, ms] of [...byPair.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (ms.length !== 2) continue;
    const [m0, m1] = ms as [MatchResult, MatchResult];
    // score of m0.a in each orientation
    const s0 = m0.score;
    const s1 = m1.a === m0.a ? m1.score : 1 - m1.score;
    if (s0 !== s1) inconsistentPairs.push(key);
  }

  return { ratings: out, records, inconsistentPairs };
}

/** Candidate's W/L/D against a given set of opponents (e.g. just the champion) — feeds promotionGate. */
export function headToHead(matchResults: MatchResult[], playerId: string, opponents?: string[]): Record3 {
  const opp = opponents ? new Set(opponents) : undefined;
  const r = blank();
  for (const m of matchResults) {
    if (m.a === m.b) continue;
    let s: number;
    if (m.a === playerId && (!opp || opp.has(m.b))) s = m.score;
    else if (m.b === playerId && (!opp || opp.has(m.a))) s = 1 - m.score;
    else continue;
    r.games++;
    if (s === 1) r.wins++;
    else if (s === 0) r.losses++;
    else r.draws++;
  }
  return r;
}
