// Glicko-2 rating system (Glickman, "Example of the Glicko-2 system", 2013),
// plus small helpers used by the promotion gate.

export interface Glicko2Player {
  r: number; // rating (Glicko scale)
  rd: number; // rating deviation
  vol: number; // volatility (sigma)
}

export interface Glicko2Result {
  opp: { r: number; rd: number };
  score: 0 | 0.5 | 1;
}

export const GLICKO2_DEFAULTS = { r: 1500, rd: 350, vol: 0.06, tau: 0.5 } as const;
const SCALE = 173.7178;
const EPS = 1e-6;

export function newPlayer(p: Partial<Glicko2Player> = {}): Glicko2Player {
  return { r: p.r ?? GLICKO2_DEFAULTS.r, rd: p.rd ?? GLICKO2_DEFAULTS.rd, vol: p.vol ?? GLICKO2_DEFAULTS.vol };
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** One rating-period update. Pure: returns a new player. Empty results only inflate RD. */
export function update(
  player: Partial<Glicko2Player>,
  results: Glicko2Result[],
  tau: number = GLICKO2_DEFAULTS.tau,
): Glicko2Player {
  const p = newPlayer(player);
  const mu = (p.r - 1500) / SCALE;
  const phi = p.rd / SCALE;
  const sigma = p.vol;

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { r: p.r, rd: Math.min(phiStar * SCALE, GLICKO2_DEFAULTS.rd), vol: sigma };
  }

  let vInv = 0;
  let deltaSum = 0;
  for (const { opp, score } of results) {
    const muJ = (opp.r - 1500) / SCALE;
    const phiJ = opp.rd / SCALE;
    const gJ = g(phiJ);
    const E = expected(mu, muJ, phiJ);
    vInv += gJ * gJ * E * (1 - E);
    deltaSum += gJ * (score - E);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: new volatility via the Illinois algorithm.
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; Math.abs(B - A) > EPS && i < 200; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;
  return { r: newMu * SCALE + 1500, rd: newPhi * SCALE, vol: newSigma };
}

/** Conservative skill estimate (~97.7% lower bound). */
export function conservative(p: { r: number; rd: number }): number {
  return p.r - 2 * p.rd;
}

/** Wilson score interval lower bound. `wins` may be fractional (draws as 0.5). */
export function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const phat = Math.min(1, Math.max(0, wins / n));
  const z2 = z * z;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

/** Win rate with draws counted as half. 0 when no games. */
export function winRate(wins: number, losses: number, draws = 0): number {
  const n = wins + losses + draws;
  return n > 0 ? (wins + draws / 2) / n : 0;
}
