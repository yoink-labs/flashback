// The room's persisted shape and the normalization that lets a deploy land on
// live rooms: every field added by a later milestone is filled in here, so the
// state machine and the views never have to handle a gap.
import type { Deck } from './bunch';
import type { RoundEffect, StreakEffect } from './effects';
import type { MediaKind, MediaMode } from './media';
import type { ScheduledRound } from './schedule';
import { defaultSettings, normalizeSettings, type Settings } from './settings';
import { normalizeItems, type Items } from './shop';

export const CAPACITY = 12;
export const MIN_PLAYERS = 2;

export type Phase = 'lobby' | 'countdown' | 'reveal' | 'results' | 'podium' | 'closed';

export interface Player {
  id: string;
  nickname: string;
  kind: 'guest' | 'clerk';
  /** Clerk `sub` for signed-in players. Never sent to other clients. */
  userID?: string;
  joinSeq: number;
  joinedAt: number;
  connected: boolean;
  disconnectedAt: number | null;
  ready: boolean;
  deck: Deck;
  score: number;
  /** Consecutive correct guesses. */
  streak: number;
  /** Consecutive wrong or missing guesses on someone else's rounds. */
  missStreak: number;
  bestStreak: number;
  correctMs: number;
  correctCount: number;
  /** Held shop power-ups, public in the view. */
  items: Items;
  /** Sent `hello` with `fairReveal`: acks media and times its own guesses (M5). */
  fairReveal?: boolean;
}

/**
 * "The item for round N." At most LOOKAHEAD of these are open at once. The
 * Durable Object keeps the uploaded bytes in memory, keyed by slot id.
 */
export interface Slot {
  /** Random, 32 hex. Never sent to clients before results. */
  id: string;
  round: number;
  ownerID: string;
  status: 'requested' | 'ready';
  requestedAt: number;
  /** The kind this round plays; the owner must upload this kind. Never sent to non-owners. */
  requiredKind: MediaKind;
  /** The uploaded item's kind, set when ready. */
  kind?: MediaKind;
  /** Owners asked for this round so far. */
  attempts: number;
  readyAt: number | null;
  /** Players who said this slot's media is decoded and ready to show (M5 §3). */
  loadedBy: string[];
  /** Players already asked for this round; never picked again for it. */
  tried: string[];
}

export interface Guess {
  targetID: string;
  elapsedMs: number;
}

export interface RoundState {
  index: number;
  slotID: string;
  ownerID: string;
  kind: MediaKind | null;
  countdownStart: number;
  /** The reveal time is fixed (phaseEndsAt) and effects are decided (M5 §3). */
  planned: boolean;
  revealAt: number | null;
  endsAt: number | null;
  /** Everyone connected when the reveal began, including the owner. */
  guessers: string[];
  guesses: Record<string, Guess>;
  /** The round-wide focus/zoom effect, decided when the reveal began. */
  effect: RoundEffect | null;
  /** Private streak effects, per non-owner guesser. */
  streakEffects: Record<string, StreakEffect>;
  /** Per player, the wrong choices their 50/50 greyed out. */
  eliminated: Record<string, string[]>;
  /** Per player, whether this round's 50/50 has been spent. */
  fiftyFiftyUsed: Record<string, boolean>;
}

export type DoubleDownOutcome = 'won' | 'lost' | 'refunded' | null;

export interface ResultRow {
  playerID: string;
  targetID: string | null;
  correct: boolean;
  /** The signed delta actually applied to the player's score. */
  points: number;
  accuracy: number;
  speed: number;
  streakBonus: number;
  streak: number;
  elapsedMs: number | null;
  total: number;
  /** Sharp eyes (§4). */
  bonus: number;
  doubleDown: DoubleDownOutcome;
  shielded: boolean;
  effect: 'greyscale' | 'blur' | null;
  roundEffect: 'focus' | 'zoom' | null;
  fiftyFifty: boolean;
  earnedFiftyFifty: boolean;
}

export interface RoundResult {
  index: number;
  ownerID: string;
  kind: MediaKind;
  rows: ResultRow[];
}

/** A client whose socket should receive a `turn` message for a slot. */
export interface TurnRequest {
  playerID: string;
  slot: string;
  game: number;
  round: number;
  mode: MediaMode;
  kind: MediaKind;
}

export interface RoomState {
  code: string;
  instance: string;
  createdAt: number;
  lastActivityAt: number;
  phase: Phase;
  hostID: string | null;
  settings: Settings;
  players: Player[];
  slots: Slot[];
  /** Rounds each player has owned this game (finished rounds only). */
  owned: Record<string, number>;
  /** Owner of the most recently finished round. */
  lastOwnerID: string | null;
  game: number;
  totalRounds: number;
  /** The kind of each round this game, balanced across photos and videos. */
  roundKinds: MediaKind[];
  /** Even Split's owner and kind for every round. Never sent to clients. */
  schedule: ScheduledRound[] | null;
  round: RoundState | null;
  lastResult: RoundResult | null;
  phaseEndsAt: number | null;
  /** When the host paused the game (null while it is running). */
  pausedAt: number | null;
  /** Time left in the phase when it was paused (null if it had no deadline). */
  pausedRemainingMs: number | null;
  /** Players who have spent their one shop buy this break. */
  shopBought: Record<string, boolean>;
  emptySince: number | null;
  nextJoinSeq: number;
}

export function newRoom(code: string, instance: string, now: number): RoomState {
  return {
    code,
    instance,
    createdAt: now,
    lastActivityAt: now,
    phase: 'lobby',
    hostID: null,
    settings: defaultSettings(),
    players: [],
    slots: [],
    owned: {},
    lastOwnerID: null,
    game: 1,
    totalRounds: 0,
    roundKinds: [],
    schedule: null,
    round: null,
    lastResult: null,
    phaseEndsAt: null,
    pausedAt: null,
    pausedRemainingMs: null,
    shopBought: {},
    emptySince: now,
    nextJoinSeq: 1,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const countIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const isKind = (value: unknown): value is MediaKind => value === 'photo' || value === 'video';

/**
 * Rooms persisted by an older build lack the pause fields, the balanced round
 * kinds, each slot's required kind, deck counts, the M4 settings, effects,
 * items, and the schedule. Normalize on load so nothing downstream has to
 * handle the gaps (and so no deadline can be computed from `undefined`).
 */
export function normalizeRoom(state: RoomState): RoomState {
  state.settings = normalizeSettings(state.settings);
  state.players = Array.isArray(state.players) ? state.players : [];
  state.slots = Array.isArray(state.slots) ? state.slots : [];
  state.owned = isRecord(state.owned) ? state.owned : {};
  state.pausedAt = state.pausedAt ?? null;
  state.pausedRemainingMs = state.pausedRemainingMs ?? null;
  state.roundKinds = Array.isArray(state.roundKinds) ? state.roundKinds.filter(isKind) : [];
  state.schedule = normalizeSchedule(state.schedule);
  state.shopBought = normalizeShopBought(state.shopBought);
  const fallbackKind: MediaKind = state.settings.mediaMode === 'videos' ? 'video' : 'photo';
  for (const slot of state.slots) {
    slot.requiredKind = slot.requiredKind ?? slot.kind ?? fallbackKind;
    slot.loadedBy = Array.isArray(slot.loadedBy) ? slot.loadedBy : [];
  }
  for (const player of state.players) {
    player.deck = player.deck ?? { photos: 0, videos: 0 };
    player.missStreak = countIn(player.missStreak, 0, 1_000_000) ? player.missStreak : 0;
    player.items = normalizeItems(player.items);
  }
  if (state.round) {
    state.round.guessers = Array.isArray(state.round.guessers) ? state.round.guessers : [];
    state.round.guesses = isRecord(state.round.guesses) ? state.round.guesses : {};
    state.round.effect = state.round.effect ?? null;
    state.round.streakEffects = isRecord(state.round.streakEffects) ? state.round.streakEffects : {};
    state.round.eliminated = isRecord(state.round.eliminated) ? state.round.eliminated : {};
    state.round.fiftyFiftyUsed = isRecord(state.round.fiftyFiftyUsed) ? state.round.fiftyFiftyUsed : {};
    if (typeof state.round.countdownStart !== 'number') state.round.countdownStart = state.lastActivityAt;
    if (typeof state.round.planned !== 'boolean') state.round.planned = state.phase !== 'countdown' || state.phaseEndsAt !== null;
  }
  if (state.lastResult) state.lastResult.rows = normalizeRows(state.lastResult.rows);
  return state;
}

function normalizeSchedule(raw: unknown): ScheduledRound[] | null {
  if (!Array.isArray(raw)) return null;
  const schedule: ScheduledRound[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.ownerID !== 'string' || !isKind(entry.kind)) return null;
    schedule.push({ ownerID: entry.ownerID, kind: entry.kind });
  }
  return schedule.length ? schedule : null;
}

function normalizeShopBought(raw: unknown): Record<string, boolean> {
  if (!isRecord(raw)) return {};
  const out: Record<string, boolean> = {};
  for (const [playerID, bought] of Object.entries(raw)) if (bought === true) out[playerID] = true;
  return out;
}

/** Rows persisted before M4 lack the new fields; give them their defaults. */
function normalizeRows(rows: unknown): ResultRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const row = isRecord(raw) ? raw : {};
    const doubleDown = row.doubleDown === 'won' || row.doubleDown === 'lost' || row.doubleDown === 'refunded' ? row.doubleDown : null;
    const effect = row.effect === 'greyscale' || row.effect === 'blur' ? row.effect : null;
    const roundEffect = row.roundEffect === 'focus' || row.roundEffect === 'zoom' ? row.roundEffect : null;
    return {
      ...(row as unknown as ResultRow),
      bonus: typeof row.bonus === 'number' ? row.bonus : 0,
      doubleDown,
      shielded: row.shielded === true,
      effect,
      roundEffect,
      fiftyFifty: row.fiftyFifty === true,
      earnedFiftyFifty: row.earnedFiftyFifty === true,
    };
  });
}
