// The Flashback v2 room protocol (docs/MILESTONE2.md), shared by the socket,
// the screens, and the deck. The server decides everything that matters; the
// client only ever sees what it is allowed to see.

export type Phase = 'lobby' | 'countdown' | 'reveal' | 'results' | 'podium' | 'closed';
export type MediaMode = 'photos' | 'videos' | 'both';
export type MediaKind = 'photo' | 'video';

export interface DeckCounts {
  photos: number;
  videos: number;
}

export interface PlayerView {
  id: string;
  nickname: string;
  signedIn: boolean;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  score: number;
  streak: number;
  /** How many deck items this player can still be asked for, by kind. */
  deck?: DeckCounts;
}

/**
 * During `countdown` only `index`, `total`, and `waiting` are meaningful.
 * During `reveal` the guess fields are present. Nothing here identifies the
 * owner — the owner is revealed in `lastResult` only.
 */
export interface RoundView {
  index: number;
  total: number;
  waiting?: boolean;
  kind?: MediaKind;
  revealAt?: number;
  endsAt?: number;
  canGuess?: boolean;
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

export interface RoundResult {
  index: number;
  ownerID: string;
  kind: MediaKind;
  rows: ResultRow[];
}

export interface PodiumRow {
  playerID: string;
  rank: number;
  score: number;
  bestStreak: number;
  correctCount: number;
}

export interface RoomSettings {
  rounds: number;
  timerSeconds: number;
  mediaMode: MediaMode;
  /** Length of the results screen between rounds (3–30). */
  breakSeconds: number;
  /** Swaps each player gets per bunch (0–10). */
  swaps: number;
}

export const DEFAULT_SETTINGS: RoomSettings = { rounds: 10, timerSeconds: 20, mediaMode: 'both', breakSeconds: 7, swaps: 3 };

const intIn = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Settings from any server (older ones lack `breakSeconds` / `swaps`). */
export function normalizeSettings(raw: Partial<RoomSettings> | null | undefined): RoomSettings {
  const s = raw ?? {};
  return {
    rounds: intIn(s.rounds, 1, 30, DEFAULT_SETTINGS.rounds),
    timerSeconds: intIn(s.timerSeconds, 10, 60, DEFAULT_SETTINGS.timerSeconds),
    mediaMode: s.mediaMode === 'photos' || s.mediaMode === 'videos' || s.mediaMode === 'both' ? s.mediaMode : DEFAULT_SETTINGS.mediaMode,
    breakSeconds: intIn(s.breakSeconds, 3, 30, DEFAULT_SETTINGS.breakSeconds),
    swaps: intIn(s.swaps, 0, 10, DEFAULT_SETTINGS.swaps),
  };
}

/** Fills in fields an older server may not send. */
export function normalizeView(raw: RoomView): RoomView {
  return {
    ...raw,
    settings: normalizeSettings(raw.settings),
    paused: raw.paused === true,
    pausedRemainingMs: typeof raw.pausedRemainingMs === 'number' ? raw.pausedRemainingMs : null,
    players: raw.players ?? [],
    podium: raw.podium ?? [],
  };
}

export interface RoomView {
  code: string;
  phase: Phase;
  game: number;
  hostID: string | null;
  capacity: number;
  settings: RoomSettings;
  serverNow: number;
  phaseEndsAt: number | null;
  /** The host paused the game; timers are frozen at `pausedRemainingMs`. */
  paused: boolean;
  pausedRemainingMs: number | null;
  startBlocker: string | null;
  players: PlayerView[];
  /** Everything the viewer is told about themselves. No items, ever. */
  you: { id: string };
  round: RoundView | null;
  lastResult: RoundResult | null;
  podium: PodiumRow[];
}

// ---- server → client ----

/** Sent only to the slot owner's sockets. The UI must never react visibly. */
export interface TurnMessage {
  type: 'turn';
  slot: string;
  game: number;
  round: number;
  mode: MediaMode;
  /** M3 §7: the kind this round needs. Absent from older servers. */
  kind?: MediaKind;
}

/** Header of a binary media frame: [4-byte BE length][JSON header][bytes]. */
export interface MediaHeader {
  type: 'media';
  game: number;
  round: number;
  kind: MediaKind;
  contentType: string;
}

export type ServerMessage =
  | { type: 'state'; state: RoomView }
  | { type: 'session'; token: string; expiresAt: number }
  | { type: 'error'; message: string; request?: string }
  | { type: 'closed'; reason: string }
  | TurnMessage;

// ---- client → server ----

export type ClientMessage =
  | { type: 'deck'; photos: number; videos: number }
  | { type: 'pass'; slot: string }
  | { type: 'needMedia'; round: number }
  | { type: 'ready'; ready: boolean }
  | ({ type: 'settings' } & Partial<RoomSettings>)
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'guess'; targetID: string }
  | { type: 'advance' }
  | { type: 'end' }
  | { type: 'playAgain' }
  | { type: 'leave' }
  | { type: 'ping' };
