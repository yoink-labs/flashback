// Pure fairness rules (src/fair.ts, docs/MILESTONE5.md §2–§6).
// Run with `npm test --prefix web`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLUR_CLEAR_FRACTION,
  bestOffset,
  blurRadiusPx,
  guessElapsedMs,
  photoScale,
  photoSize,
  pongSample,
  pushClockSample,
  revealDue,
} from '../src/fair.ts';

// ---- §2 clock offset ----

test('a pong sample uses half the round trip', () => {
  // Sent at t0=1000, received at t1=1120 (rtt 120). The server said 50 000;
  // its clock was that at the middle of the trip, 1060 local, so offset 48 940.
  const sample = pongSample(1000, 1120, 50_000);
  assert.equal(sample.rtt, 120);
  assert.equal(sample.offset, 48_940);
  assert.equal(1060 + sample.offset, 50_000);
});

test('the lowest-RTT sample wins, whatever order it arrived in', () => {
  const samples = [
    { rtt: 90, offset: 5_000 },
    { rtt: 12, offset: 4_100 },
    { rtt: 40, offset: 9_999 },
  ];
  assert.equal(bestOffset(samples), 4_100);
  assert.equal(bestOffset([]), null);
});

test('a tie goes to the newest sample', () => {
  assert.equal(bestOffset([{ rtt: 20, offset: 100 }, { rtt: 20, offset: 200 }]), 200);
});

test('non-finite samples are ignored', () => {
  assert.equal(bestOffset([{ rtt: Number.NaN, offset: 1 }, { rtt: 30, offset: 7 }]), 7);
  assert.equal(bestOffset([{ rtt: 1, offset: Number.POSITIVE_INFINITY }]), null);
});

test('only the last eight samples are kept', () => {
  let samples: { rtt: number; offset: number }[] = [];
  for (let i = 0; i < 12; i++) samples = pushClockSample(samples, { rtt: i, offset: i });
  assert.equal(samples.length, 8);
  assert.deepEqual(samples[0], { rtt: 4, offset: 4 });
  assert.deepEqual(samples[7], { rtt: 11, offset: 11 });
});

// ---- §4 guess timing ----

test('elapsed time runs from the reveal for an on-time viewer', () => {
  // Reveal at 10 000, media on screen at 9 800 (already ready), tap at 12 840.
  assert.equal(guessElapsedMs(12_840, 10_000, 9_800), 2_840);
});

test('a late viewer is timed from when the media first showed', () => {
  assert.equal(guessElapsedMs(12_000, 10_000, 11_500), 500);
});

test('a tap cannot be earlier than zero', () => {
  assert.equal(guessElapsedMs(9_000, 10_000, 9_500), 0);
});

// ---- §5 blur fade ----

test('streak blur clears linearly to zero at 75% of the timer', () => {
  const base = 0.04 * 500; // medium on a 500 px shorter side = 20 px
  assert.equal(blurRadiusPx(0.04, 500, 0, 20_000), base);
  assert.equal(blurRadiusPx(0.04, 500, (20_000 * BLUR_CLEAR_FRACTION) / 2, 20_000), base / 2);
  assert.equal(blurRadiusPx(0.04, 500, 20_000 * BLUR_CLEAR_FRACTION, 20_000), 0);
  assert.equal(blurRadiusPx(0.04, 500, 20_000, 20_000), 0);
});

test('blur is scale-free in the media size and safe with no timer', () => {
  // The same fraction of a smaller box means fewer pixels.
  assert.equal(blurRadiusPx(0.07, 250, 0, 10_000), 17.5);
  assert.equal(blurRadiusPx(0.04, 500, 0, 0), 0);
  assert.equal(blurRadiusPx(0.04, 0, 0, 10_000), 0);
  // A negative elapsed (clock noise) means no fade yet.
  assert.equal(blurRadiusPx(0.04, 500, -80, 20_000), 20);
});

// ---- §6 upload sizing ----

test('a 4:3 photo keeps 1440 × 1080', () => {
  assert.deepEqual(photoSize(1440, 1080), { width: 1440, height: 1080 });
  assert.equal(photoScale(1440, 1080), 1);
  // A 12 MP camera photo is scaled by area, not just its long edge.
  assert.ok(Math.abs(photoScale(4032, 3024) - Math.sqrt(1_555_200 / (4032 * 3024))) < 1e-12);
});

test('an 8000 × 1600 panorama scales by area', () => {
  const size = photoSize(8000, 1600);
  // scale = sqrt(1 555 200 / 12 800 000) ≈ 0.3486
  assert.equal(size.width, 2789);
  assert.equal(size.height, 558);
  assert.ok(Math.abs(photoScale(8000, 1600) - 0.34857) < 0.0001);
});

test('the 3072 px edge cap wins for extreme shapes', () => {
  const scale = photoScale(10_000, 100);
  assert.equal(scale, 3072 / 10_000);
  assert.deepEqual(photoSize(10_000, 100), { width: 3072, height: 31 });
});

test('small photos are never upscaled', () => {
  assert.equal(photoScale(300, 200), 1);
  assert.deepEqual(photoSize(300, 200), { width: 300, height: 200 });
  assert.equal(photoScale(0, 0), 1);
});

test('the area budget is exactly 1440 × 1080', () => {
  // A square of that area is the largest square that fits.
  const side = Math.sqrt(1_555_200);
  assert.ok(Math.abs(photoScale(side, side) - 1) < 1e-12);
  assert.ok(photoScale(side * 2, side * 2) < 1);
});

// ---- §3 local reveal decision ----

test('the reveal starts locally only once time and media are both there', () => {
  const base = { phase: 'countdown' as const, revealAt: 20_000, now: 20_000, mediaReady: true };
  assert.equal(revealDue(base), true);
  assert.equal(revealDue({ ...base, now: 19_999 }), false);
  assert.equal(revealDue({ ...base, mediaReady: false }), false);
  assert.equal(revealDue({ ...base, paused: true }), false);
  assert.equal(revealDue({ ...base, phase: 'reveal' }), false);
  assert.equal(revealDue({ ...base, revealAt: null }), false);
  assert.equal(revealDue({ ...base, revealAt: undefined }), false);
});
