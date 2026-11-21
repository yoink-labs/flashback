// Fairness maths (docs/MILESTONE5.md): clock-offset estimation, guess timing,
// effect clocks and upload sizing. Pure functions only — no DOM, no React — so
// the rules that decide who sees what, when, can be unit-tested.
import type { Phase } from './types';

/** How many clock samples the estimator keeps (§2). */
export const CLOCK_SAMPLES = 8;
/** Blur is fully sharp at this fraction of the round's timer (§5). */
export const BLUR_CLEAR_FRACTION = 0.75;
/** 1440 × 1080: the photo area budget (§6). */
export const PHOTO_AREA_BUDGET = 1_555_200;
/** No photo edge may exceed this, however thin and long it is (§6). */
export const PHOTO_MAX_EDGE = 3072;

export interface ClockSample {
  /** Round-trip time in ms. */
  rtt: number;
  /** `serverNow + rtt / 2 − t1`, in ms. */
  offset: number;
}

/** One pong's sample: t0 local send, t1 local receive, the server's timestamp. */
export function pongSample(t0: number, t1: number, serverNow: number): ClockSample {
  const rtt = Math.max(0, t1 - t0);
  return { rtt, offset: serverNow + rtt / 2 - t1 };
}

/** Appends a sample, keeping only the newest `limit` (§2). */
export function pushClockSample(samples: readonly ClockSample[], sample: ClockSample, limit = CLOCK_SAMPLES): ClockSample[] {
  const next = [...samples, sample];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * The offset of the sample with the lowest RTT. The newest sample wins a tie,
 * so a fresh connection's pong replaces an equally fast older one.
 */
export function bestOffset(samples: readonly ClockSample[]): number | null {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.rtt) || !Number.isFinite(sample.offset)) continue;
    if (!best || sample.rtt <= best.rtt) best = sample;
  }
  return best ? best.offset : null;
}

/**
 * §4: the tap's elapsed time, measured from the later of the reveal time and
 * the moment this client first had the media on screen.
 */
export function guessElapsedMs(tapAt: number, revealAt: number, firstDisplayedAt: number): number {
  return Math.max(0, tapAt - Math.max(revealAt, firstDisplayedAt));
}

/**
 * §5: the streak blur radius at `elapsedMs`, linear from `baseFraction` of the
 * media's shorter side to 0 at 75% of the timer.
 */
export function blurRadiusPx(baseFraction: number, shorterSidePx: number, elapsedMs: number, timerMs: number): number {
  if (!(timerMs > 0) || !(shorterSidePx > 0) || !(baseFraction > 0)) return 0;
  const fade = Math.max(0, 1 - Math.max(0, elapsedMs) / (BLUR_CLEAR_FRACTION * timerMs));
  return baseFraction * shorterSidePx * fade;
}

/** §6: the photo scale, by area rather than long edge. */
export function photoScale(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.min(1, Math.sqrt(PHOTO_AREA_BUDGET / (width * height)), PHOTO_MAX_EDGE / Math.max(width, height));
}

/** The scaled photo's pixel size, at least 1 px on each side. */
export function photoSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const scale = photoScale(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * §3: whether this client should flip from the countdown to the reveal on its
 * own — the time is fixed, it has passed, and the media can be shown.
 */
export function revealDue(input: {
  phase: Phase;
  revealAt: number | null | undefined;
  now: number;
  mediaReady: boolean;
  paused?: boolean;
}): boolean {
  if (input.phase !== 'countdown' || input.paused) return false;
  if (typeof input.revealAt !== 'number' || !Number.isFinite(input.revealAt)) return false;
  return input.mediaReady && input.now >= input.revealAt;
}
