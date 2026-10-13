// Deterministic Thompson-sampling bandit (Beta-Bernoulli) with a seeded PRNG.

export type Rng = () => number; // uniform in [0, 1)

/** mulberry32: tiny, fast, seeded 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash, for turning string seeds into numbers. */
export function hashSeed(s: string | number): number {
  if (typeof s === "number") return s >>> 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normal(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) via Marsaglia–Tsang; shape < 1 uses the boost trick. */
export function sampleGamma(shape: number, rng: Rng): number {
  if (!(shape > 0)) throw new Error("gamma shape must be > 0");
  if (shape < 1) {
    let u = 0;
    while (u === 0) u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(alpha, beta) = X / (X + Y), X~Gamma(alpha), Y~Gamma(beta). */
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

export interface ArmState {
  alpha: number;
  beta: number;
}
export interface BanditJSON {
  prior: ArmState;
  arms: Record<string, ArmState>;
}

export class ThompsonBandit {
  readonly prior: ArmState;
  private arms = new Map<string, ArmState>();

  constructor(armIds: string[] = [], prior: ArmState = { alpha: 1, beta: 1 }) {
    if (!(prior.alpha > 0 && prior.beta > 0)) throw new Error("prior must be positive");
    this.prior = { ...prior };
    for (const id of armIds) this.addArm(id);
  }

  addArm(id: string): void {
    if (!this.arms.has(id)) this.arms.set(id, { ...this.prior });
  }

  removeArm(id: string): void {
    this.arms.delete(id);
  }

  armIds(): string[] {
    return [...this.arms.keys()].sort();
  }

  get(id: string): ArmState | undefined {
    const s = this.arms.get(id);
    return s ? { ...s } : undefined;
  }

  /** Posterior mean success probability. */
  mean(id: string): number {
    const s = this.arms.get(id);
    if (!s) throw new Error(`unknown arm: ${id}`);
    return s.alpha / (s.alpha + s.beta);
  }

  /** Deterministic for a given seed and state (arms sampled in sorted id order). */
  choose(seed: number | string): string {
    const ids = this.armIds();
    if (ids.length === 0) throw new Error("bandit has no arms");
    const rng = mulberry32(hashSeed(seed));
    let best = ids[0]!;
    let bestDraw = -1;
    for (const id of ids) {
      const s = this.arms.get(id)!;
      const draw = sampleBeta(s.alpha, s.beta, rng);
      if (draw > bestDraw) {
        bestDraw = draw;
        best = id;
      }
    }
    return best;
  }

  update(arm: string, success: boolean): void {
    this.addArm(arm);
    const s = this.arms.get(arm)!;
    if (success) s.alpha += 1;
    else s.beta += 1;
  }

  /** Shrink evidence toward the prior (factor in [0,1]; 1 = no change, 0 = reset). */
  decay(factor: number): void {
    if (!(factor >= 0 && factor <= 1)) throw new Error("decay factor must be in [0,1]");
    for (const s of this.arms.values()) {
      s.alpha = this.prior.alpha + (s.alpha - this.prior.alpha) * factor;
      s.beta = this.prior.beta + (s.beta - this.prior.beta) * factor;
    }
  }

  toJSON(): BanditJSON {
    const arms: Record<string, ArmState> = {};
    for (const id of this.armIds()) arms[id] = { ...this.arms.get(id)! };
    return { prior: { ...this.prior }, arms };
  }

  static fromJSON(json: BanditJSON): ThompsonBandit {
    const b = new ThompsonBandit([], json.prior);
    for (const [id, s] of Object.entries(json.arms)) {
      if (!(s.alpha > 0 && s.beta > 0)) throw new Error(`invalid arm state: ${id}`);
      b.arms.set(id, { alpha: s.alpha, beta: s.beta });
    }
    return b;
  }
}
