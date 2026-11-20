// Flashback scoring. Deterministic and mirrored in the iOS app (Scoring.swift).
//
// A correct guess earns:
//   accuracy  500 points
//   speed     up to 500 points: round(500 × remaining time ÷ round time)
//   streak    100 points per previous consecutive correct guess, capped at 500
// A wrong, late, or missing guess earns 0 and resets the streak. The owner of
// the item sits the round out; their streak is unchanged.
//
// Ranking ties:
//   round results: earlier guess first, then join order
//   final podium:  less total time spent on correct guesses first, then join order
export const ACCURACY_POINTS = 500;
export const SPEED_POINTS = 500;
export const STREAK_STEP = 100;
export const STREAK_BONUS_CAP = 5;

export interface GuessScore {
  correct: boolean;
  points: number;
  accuracy: number;
  speed: number;
  streakBonus: number;
  streak: number;
}

export function scoreGuess(input: { correct: boolean; elapsedMs: number | null; timerMs: number; previousStreak: number }): GuessScore {
  const { correct, elapsedMs, timerMs, previousStreak } = input;
  if (!correct || elapsedMs === null || elapsedMs < 0 || elapsedMs > timerMs || timerMs <= 0)
    return { correct: false, points: 0, accuracy: 0, speed: 0, streakBonus: 0, streak: 0 };
  const remaining = timerMs - elapsedMs;
  const speed = Math.round((SPEED_POINTS * remaining) / timerMs);
  const streak = previousStreak + 1;
  const streakBonus = STREAK_STEP * Math.min(streak - 1, STREAK_BONUS_CAP);
  return { correct: true, points: ACCURACY_POINTS + speed + streakBonus, accuracy: ACCURACY_POINTS, speed, streakBonus, streak };
}

export interface Rankable {
  id: string;
  score: number;
  joinSeq: number;
  /** Sum of elapsed ms across this player's correct guesses. */
  correctMs: number;
}

export function rankFinal<T extends Rankable>(players: T[]): T[] {
  return [...players].sort((a, b) => b.score - a.score || a.correctMs - b.correctMs || a.joinSeq - b.joinSeq);
}

export interface RoundRankable {
  playerID: string;
  points: number;
  joinSeq: number;
  /** Elapsed ms when the guess landed, or null if no guess. */
  elapsedMs: number | null;
}

export function rankRound<T extends RoundRankable>(rows: T[]): T[] {
  const time = (r: T) => (r.elapsedMs === null ? Number.POSITIVE_INFINITY : r.elapsedMs);
  return [...rows].sort((a, b) => b.points - a.points || time(a) - time(b) || a.joinSeq - b.joinSeq);
}
