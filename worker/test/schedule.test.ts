import { describe, expect, it } from 'vitest';
import { evenSplitSchedule, type ScheduledRound } from '../src/schedule';
import type { MediaMode } from '../src/media';

/** A small deterministic PRNG so schedules are varied but reproducible. */
function seeded(seed: number) {
  let state = seed >>> 0;
  let n = 0;
  return {
    float: () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    },
    id: () => `id${++n}`,
  };
}

const players = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `p${i}` }));

function counts(schedule: ScheduledRound[]) {
  const out = new Map<string, { rounds: number; photos: number; videos: number }>();
  for (const round of schedule) {
    const entry = out.get(round.ownerID) ?? { rounds: 0, photos: 0, videos: 0 };
    entry.rounds += 1;
    if (round.kind === 'photo') entry.photos += 1;
    else entry.videos += 1;
    out.set(round.ownerID, entry);
  }
  return out;
}

function expectNoBackToBack(schedule: ScheduledRound[]) {
  for (let i = 1; i < schedule.length; i++) expect(schedule[i].ownerID, `round ${i + 1}`).not.toBe(schedule[i - 1].ownerID);
}

/** Every owner's kinds follow the Mix third rule: videos = round(c / 3). */
function expectKinds(schedule: ScheduledRound[], mode: MediaMode) {
  for (const [ownerID, entry] of counts(schedule)) {
    const videos = mode === 'photos' ? 0 : mode === 'videos' ? entry.rounds : Math.round(entry.rounds / 3);
    expect(entry.videos, ownerID).toBe(videos);
    expect(entry.photos, ownerID).toBe(entry.rounds - videos);
  }
}

describe('Even Split schedule', () => {
  it('gives the remaining rounds to random players and never repeats an owner', () => {
    const schedule = evenSplitSchedule(7, players(3), 'both', seeded(1));
    expect(schedule).toHaveLength(7);
    const byOwner = [...counts(schedule).values()].map((entry) => entry.rounds).sort();
    expect(byOwner).toEqual([2, 2, 3]);
    for (const entry of counts(schedule).values()) expect(entry.rounds).toBeGreaterThanOrEqual(2);
    expectNoBackToBack(schedule);
    expectKinds(schedule, 'both');
    expect(schedule.filter((round) => round.kind === 'video')).toHaveLength(3);
    expect(schedule.filter((round) => round.kind === 'photo')).toHaveLength(4);
  });

  it('handles 50 rounds across 9 players (six-round shares and five-round shares)', () => {
    const schedule = evenSplitSchedule(50, players(9), 'both', seeded(7));
    expect(schedule).toHaveLength(50);
    const shares = [...counts(schedule).values()].map((entry) => entry.rounds).sort();
    // 50 = 9 * 5 + 5: five players own 6 rounds, four own 5.
    expect(shares.filter((share) => share === 6)).toHaveLength(5);
    expect(shares.filter((share) => share === 5)).toHaveLength(4);
    expectNoBackToBack(schedule);
    expectKinds(schedule, 'both');
    expect(schedule.filter((round) => round.kind === 'video')).toHaveLength(18);
  });

  it('handles 50 rounds across 5 players (a clean 10 each)', () => {
    const schedule = evenSplitSchedule(50, players(5), 'both', seeded(3));
    expect(schedule).toHaveLength(50);
    expect([...counts(schedule).values()].map((entry) => entry.rounds)).toEqual([10, 10, 10, 10, 10]);
    expectNoBackToBack(schedule);
    expectKinds(schedule, 'both');
  });

  it('handles 100 rounds across 12 players', () => {
    const schedule = evenSplitSchedule(100, players(12), 'both', seeded(11));
    expect(schedule).toHaveLength(100);
    const shares = [...counts(schedule).values()].map((entry) => entry.rounds);
    // 100 = 12 * 8 + 4.
    expect(shares.filter((share) => share === 9)).toHaveLength(4);
    expect(shares.filter((share) => share === 8)).toHaveLength(8);
    expectNoBackToBack(schedule);
    expectKinds(schedule, 'both');
    expect(schedule.filter((round) => round.kind === 'video')).toHaveLength(36);
  });

  it('uses a single kind in Photos and Videos rooms', () => {
    const photos = evenSplitSchedule(21, players(4), 'photos', seeded(2));
    const videos = evenSplitSchedule(21, players(4), 'videos', seeded(2));
    expect(photos.every((round) => round.kind === 'photo')).toBe(true);
    expect(videos.every((round) => round.kind === 'video')).toBe(true);
    expectKinds(photos, 'photos');
    expectKinds(videos, 'videos');
    expectNoBackToBack(photos);
    expectNoBackToBack(videos);
  });

  it('never puts the same owner back to back when it can be avoided', () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const n of [2, 3, 4, 5, 12]) {
        for (const rounds of [1, 2, 3, 7, 10, 50, 100]) {
          if (rounds < 2) continue;
          const schedule = evenSplitSchedule(rounds, players(n), 'both', seeded(seed * 97 + n * 13 + rounds));
          expect(schedule, `seed ${seed} n ${n} rounds ${rounds}`).toHaveLength(rounds);
          expectNoBackToBack(schedule);
          const shares = [...counts(schedule).values()].map((entry) => entry.rounds);
          expect(Math.max(...shares) - Math.min(...shares), `seed ${seed} n ${n} rounds ${rounds}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('falls back gracefully for an empty or zero-round game', () => {
    expect(evenSplitSchedule(0, players(3), 'both', seeded(1))).toEqual([]);
    expect(evenSplitSchedule(5, [], 'both', seeded(1))).toEqual([]);
    expect(evenSplitSchedule(1, players(2), 'both', seeded(1))).toHaveLength(1);
  });
});
