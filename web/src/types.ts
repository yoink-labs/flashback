// Mirrors worker/src/game.ts `Game.view` (what one player may see).
export type Phase = 'lobby' | 'countdown' | 'reveal' | 'results' | 'podium' | 'closed';
export type MediaMode = 'photos' | 'videos' | 'both';
export type MediaKind = 'photo' | 'video';

export interface PlayerView {
  id: string;
  nickname: string;
  signedIn: boolean;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  score: number;
  streak: number;
  photos: number;
  videos: number;
}

export interface RoundView {
  index: number;
  total: number;
  kind?: MediaKind;
  mediaPath?: string;
  revealAt?: number;
  endsAt?: number;
  canGuess?: boolean;
  isYours?: boolean;
  yourGuess?: string | null;
  guessedCount?: number;
  guesserCount?: number;
}

export interface ResultRow {
  playerID: string;
  targetID: string | null;
  correct: boolean;
  points: number;
  accuracy: number;
  speed: number;
  streakBonus: number;
  streak: number;
  elapsedMs: number | null;
  total: number;
}

export interface RoomView {
  code: string;
  phase: Phase;
  game: number;
  hostID: string | null;
  capacity: number;
  settings: { rounds: number; timerSeconds: number; mediaMode: MediaMode };
  serverNow: number;
  phaseEndsAt: number | null;
  startBlocker: string | null;
  players: PlayerView[];
  you: { id: string; items: { id: string; kind: MediaKind; durationMs: number | null }[] };
  round: RoundView | null;
  lastResult: { index: number; ownerID: string; kind: MediaKind; rows: ResultRow[] } | null;
  podium: { playerID: string; rank: number; score: number; bestStreak: number; correctCount: number }[];
}

export type ClientMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'settings'; rounds?: number; timerSeconds?: number; mediaMode?: MediaMode }
  | { type: 'start' }
  | { type: 'guess'; targetID: string }
  | { type: 'advance' }
  | { type: 'end' }
  | { type: 'playAgain' }
  | { type: 'removeItem'; itemID: string }
  | { type: 'leave' }
  | { type: 'ping' };
