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
  | { type: 'settings'; rounds?: number; timerSeconds?: number; mediaMode?: MediaMode }
  | { type: 'start' }
  | { type: 'guess'; targetID: string }
  | { type: 'advance' }
  | { type: 'end' }
  | { type: 'playAgain' }
  | { type: 'leave' }
  | { type: 'ping' };

export const MODE_LABEL: Record<MediaMode, string> = {
  photos: 'Photos',
  videos: 'Videos',
  both: 'Photos & videos',
};

export const modeSummary = (mode: MediaMode) => (mode === 'photos' ? 'Photos only' : mode === 'videos' ? 'Videos only' : 'Photos & videos');
