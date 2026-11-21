// Random picks shared by the schedule and the 50/50. Randomness is always
// passed in so every decision is deterministic in tests.
export interface FloatSource {
  /** Uniform float in [0, 1). */
  float(): number;
}

/** A shuffled copy (Fisher–Yates). */
export function shuffled<T>(items: readonly T[], random: FloatSource): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random.float() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

/** `count` distinct items chosen at random, in random order. */
export function pickSome<T>(items: readonly T[], count: number, random: FloatSource): T[] {
  const take = Math.min(Math.max(0, Math.floor(count)), items.length);
  return shuffled(items, random).slice(0, take);
}
