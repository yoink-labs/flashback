import { describe, expect, it } from 'vitest';
import { rankFinal, rankRound, scoreGuess } from '../src/scoring';

const timerMs = 20_000;
describe('scoring', () => {
  it('awards accuracy plus speed for a correct guess', () => {
    expect(scoreGuess({ correct: true, elapsedMs: 0, timerMs, previousStreak: 0 })).toEqual({ correct: true, points: 1000, accuracy: 500, speed: 500, streakBonus: 0, streak: 1 });
    expect(scoreGuess({ correct: true, elapsedMs: 5_000, timerMs, previousStreak: 0 }).points).toBe(875);
    expect(scoreGuess({ correct: true, elapsedMs: 20_000, timerMs, previousStreak: 0 }).points).toBe(500);
    // Rounding is deterministic: 500 × 13333 / 20000 = 333.325 → 333.
    expect(scoreGuess({ correct: true, elapsedMs: 6_667, timerMs, previousStreak: 0 }).speed).toBe(333);
  });

  it('scores wrong, missing, and late guesses as zero and resets the streak', () => {
    for (const input of [
      { correct: false, elapsedMs: 100 },
      { correct: true, elapsedMs: null },
      { correct: true, elapsedMs: 20_001 },
      { correct: true, elapsedMs: -1 },
    ])
      expect(scoreGuess({ ...input, timerMs, previousStreak: 4 })).toEqual({ correct: false, points: 0, accuracy: 0, speed: 0, streakBonus: 0, streak: 0 });
  });

  it('adds 100 per previous consecutive correct guess, capped at 500', () => {
    const bonus = (previousStreak: number) => scoreGuess({ correct: true, elapsedMs: timerMs, timerMs, previousStreak }).streakBonus;
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(bonus)).toEqual([0, 100, 200, 300, 400, 500, 500, 500]);
    expect(scoreGuess({ correct: true, elapsedMs: 0, timerMs, previousStreak: 2 })).toMatchObject({ points: 1200, streak: 3 });
  });

  it('ranks rounds by points, then earlier guess, then join order', () => {
    const rows = [
      { playerID: 'c', points: 800, elapsedMs: 3000, joinSeq: 3 },
      { playerID: 'a', points: 800, elapsedMs: 3000, joinSeq: 1 },
      { playerID: 'b', points: 800, elapsedMs: 2000, joinSeq: 2 },
      { playerID: 'd', points: 0, elapsedMs: null, joinSeq: 4 },
      { playerID: 'e', points: 0, elapsedMs: 100, joinSeq: 5 },
      { playerID: 'f', points: 900, elapsedMs: 9000, joinSeq: 6 },
    ];
    expect(rankRound(rows).map((r) => r.playerID)).toEqual(['f', 'b', 'a', 'c', 'e', 'd']);
  });

  it('ranks the podium by score, then less time on correct guesses, then join order', () => {
    const players = [
      { id: 'late', score: 1500, correctMs: 9000, joinSeq: 1 },
      { id: 'top', score: 2000, correctMs: 9999, joinSeq: 4 },
      { id: 'early', score: 1500, correctMs: 4000, joinSeq: 3 },
      { id: 'tie2', score: 1500, correctMs: 9000, joinSeq: 2 },
    ];
    expect(rankFinal(players).map((p) => p.id)).toEqual(['top', 'early', 'late', 'tie2']);
  });
});
