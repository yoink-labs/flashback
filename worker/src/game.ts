// The Flashback room state machine. Pure and deterministic: time and randomness
// are passed in, and side effects (turns to request, media bytes to free, room
// teardown) are returned for the Durable Object to perform. The Durable Object is
// a thin adapter.
//
// Phases: lobby → countdown → reveal → results → (countdown … | podium) → lobby
//
// Milestone 2: nothing is uploaded in the lobby. Each round asks one player's
// device for one item just before it is shown (with one round of lookahead) and
// the Durable Object holds only that item, in memory. Everyone guesses each
// round, including the item's owner; nobody learns the owner before results.
//
// Start rule: the host can start when at least two players are in the room,
// every other player is ready (pressing Start is the host's ready), and every
// player's local bunch is full for the mode (12 photos and/or 6 videos).
//
// Milestone 3 adds host pause/resume, a host-set break length between rounds,
// and a balanced photo/video kind for every round, decided at start.
import { balancedRoundKinds, deckFits, deckNeed, type Deck } from './bunch';
import { type MediaKind, type MediaMode } from './media';
import { assertUniqueNickname, normalizeNickname } from './nickname';
import { beginPause, clearPause, endPause } from './pause';
import { rankFinal, rankRound, scoreGuess } from './scoring';

export const CAPACITY = 12;
export const MIN_PLAYERS = 2;
/** How many rounds ahead a slot is opened (the current round and the next). */
export const LOOKAHEAD = 2;
export const COUNTDOWN_MS = 3_000;
/** After the round's media is ready, give every client time to receive it. */
export const MEDIA_SETTLE_MS = 1_200;
/** A requested slot with no upload is reassigned after this long. */
export const UPLOAD_TIMEOUT_MS = 20_000;
/** A pause longer than this resumes itself. */
export const PAUSE_MAX_MS = 10 * 60_000;
/** A dropped player keeps their seat this long (app switch, fold, flaky Wi-Fi). */
export const DISCONNECT_GRACE_MS = 90_000;
/**
 * A dropped host keeps the host role this long before it moves on. Phones drop
 * their socket whenever the host switches apps (to share the invite, say).
 */
export const HOST_GRACE_MS = 15_000;
/** A room with nobody connected is torn down after this. */
export const EMPTY_ROOM_GRACE_MS = 2 * 60_000;
/** Finished games (podium) with no Play Again are torn down after this. */
export const FINISHED_ROOM_GRACE_MS = 15 * 60_000;
/** Lobbies with no activity are torn down after this. */
export const IDLE_ROOM_MS = 60 * 60_000;
export const ROUNDS = { min: 1, max: 30, default: 10 } as const;
export const TIMER_SECONDS = { min: 10, max: 60, default: 20 } as const;
export const BREAK_SECONDS = { min: 3, max: 30, default: 7 } as const;
export const SWAPS = { min: 0, max: 10, default: 3 } as const;
export const DECK_MAX = 500;
export const MEDIA_MODES: readonly MediaMode[] = ['photos', 'videos', 'both'];

export type Phase = 'lobby' | 'countdown' | 'reveal' | 'results' | 'podium' | 'closed';

export interface Settings {
  rounds: number;
  timerSeconds: number;
  mediaMode: MediaMode;
  /** How long the results screen lasts between rounds. */
  breakSeconds: number;
  /** How many times a player may swap a tile in their bunch (clients only). */
  swaps: number;
}


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
  streak: number;
  bestStreak: number;
  correctMs: number;
  correctCount: number;
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
  revealAt: number | null;
  endsAt: number | null;
  /** Everyone connected when the reveal began, including the owner. */
  guessers: string[];
  guesses: Record<string, Guess>;
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
  round: RoundState | null;
  lastResult: RoundResult | null;
  phaseEndsAt: number | null;
  /** When the host paused the game (null while it is running). */
  pausedAt: number | null;
  /** Time left in the phase when it was paused (null if it had no deadline). */
  pausedRemainingMs: number | null;
  emptySince: number | null;
  nextJoinSeq: number;
}

export class GameError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Identity {
  kind: 'guest' | 'clerk';
  userID?: string;
}

export interface Randomness {
  /** Uniform float in [0, 1). */
  float(): number;
  /** Unguessable identifier. */
  id(): string;
}

export const defaultRandomness: Randomness = {
  float: () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32,
  id: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
};

export function newRoom(code: string, instance: string, now: number): RoomState {
  return {
    code,
    instance,
    createdAt: now,
    lastActivityAt: now,
    phase: 'lobby',
    hostID: null,
    settings: {
      rounds: ROUNDS.default,
      timerSeconds: TIMER_SECONDS.default,
      mediaMode: 'both',
      breakSeconds: BREAK_SECONDS.default,
      swaps: SWAPS.default,
    },
    players: [],
    slots: [],
    owned: {},
    lastOwnerID: null,
    game: 1,
    totalRounds: 0,
    roundKinds: [],
    round: null,
    lastResult: null,
    phaseEndsAt: null,
    pausedAt: null,
    pausedRemainingMs: null,
    emptySince: now,
    nextJoinSeq: 1,
  };
}

const intIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

/** Fills anything missing or out of range, so every reader sees the full settings shape. */
function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const settings = raw ?? {};
  return {
    rounds: intIn(settings.rounds, ROUNDS) ? settings.rounds : ROUNDS.default,
    timerSeconds: intIn(settings.timerSeconds, TIMER_SECONDS) ? settings.timerSeconds : TIMER_SECONDS.default,
    mediaMode: MEDIA_MODES.includes(settings.mediaMode as MediaMode) ? (settings.mediaMode as MediaMode) : 'both',
    breakSeconds: intIn(settings.breakSeconds, BREAK_SECONDS) ? settings.breakSeconds : BREAK_SECONDS.default,
    swaps: intIn(settings.swaps, SWAPS) ? settings.swaps : SWAPS.default,
  };
}

/**
 * Rooms persisted by an older build lack `breakSeconds`, `swaps`, the pause
 * fields, the balanced round kinds, each slot's required kind, deck counts, and
 * a countdown start. Normalize on load so nothing downstream has to handle the
 * gaps (and so no deadline can be computed from `undefined`).
 */
export function normalizeRoom(state: RoomState): RoomState {
  state.settings = normalizeSettings(state.settings);
  state.players = state.players ?? [];
  state.slots = state.slots ?? [];
  state.owned = state.owned ?? {};
  state.pausedAt = state.pausedAt ?? null;
  state.pausedRemainingMs = state.pausedRemainingMs ?? null;
  state.roundKinds = Array.isArray(state.roundKinds) ? state.roundKinds : [];
  const fallbackKind: MediaKind = state.settings.mediaMode === 'videos' ? 'video' : 'photo';
  for (const slot of state.slots) slot.requiredKind = slot.requiredKind ?? slot.kind ?? fallbackKind;
  for (const player of state.players) player.deck = player.deck ?? { photos: 0, videos: 0 };
  if (state.round && typeof state.round.countdownStart !== 'number') state.round.countdownStart = state.lastActivityAt;
  return state;
}

export class Game {
  /** Turns the Durable Object should deliver (only to each owner's sockets). */
  turnRequests: TurnRequest[] = [];
  /** Slots whose media bytes the Durable Object should drop from memory. */
  freedSlots: string[] = [];
  /** Players removed by this mutation (their sockets should be closed). */
  removed: string[] = [];

  constructor(
    public state: RoomState,
    private random: Randomness = defaultRandomness,
  ) {
    normalizeRoom(state);
  }

  // ---- queries ----

  player(id: string) {
    return this.state.players.find((p) => p.id === id);
  }

  playerForUser(userID: string) {
    return this.state.players.find((p) => p.userID === userID);
  }

  private require(id: string) {
    const p = this.player(id);
    if (!p) throw new GameError(403, 'You are no longer in this room.');
    return p;
  }

  private requireHost(id: string) {
    this.require(id);
    if (this.state.hostID !== id) throw new GameError(403, 'Only the host can do that.');
  }

  private bunchFits(deck: Deck) {
    return deckFits(deck, this.state.settings.mediaMode);
  }

  /** Whether the deck still has an item of the round's kind to offer. */
  private hasKind(deck: Deck, kind: MediaKind) {
    return kind === 'photo' ? deck.photos > 0 : deck.videos > 0;
  }

  private slotForRound(round: number) {
    return this.state.slots.find((slot) => slot.round === round);
  }

  /** The kind round N plays, from the balanced list decided at start. */
  private kindForRound(round: number): MediaKind {
    return this.state.roundKinds[round - 1] ?? (this.state.settings.mediaMode === 'videos' ? 'video' : 'photo');
  }

  /**
   * Why the host cannot start yet, worded for one viewer (default: the host),
   * or null if they can. "You" when it is the viewer's own deck or Ready.
   */
  startBlocker(viewerID: string | null = this.state.hostID): string | null {
    const s = this.state;
    if (s.phase !== 'lobby') return 'A game is already running.';
    if (s.players.length < MIN_PLAYERS) return 'Waiting for players';
    for (const p of s.players) {
      const need = deckNeed(p.deck, s.settings.mediaMode);
      if (need) return p.id === viewerID ? need : `Waiting for ${p.nickname}`;
    }
    // The host never presses Ready: pressing Start is their ready.
    for (const p of s.players) {
      if (!p.ready && p.id !== s.hostID) return p.id === viewerID ? 'Tap Ready when your bunch looks good' : `Waiting for ${p.nickname}`;
    }
    return null;
  }

  // ---- membership ----

  join(identity: Identity, nicknameInput: unknown, now: number): Player {
    const s = this.state;
    if (s.phase === 'closed') throw new GameError(410, 'This room has closed.');
    if (identity.kind === 'clerk' && identity.userID) {
      const existing = this.playerForUser(identity.userID);
      if (existing) return existing;
    }
    if (s.phase !== 'lobby' && s.phase !== 'podium') throw new GameError(409, 'A game is in progress. Join when it finishes.');
    if (s.players.length >= CAPACITY) throw new GameError(409, `This room is full (${CAPACITY} players).`);
    let nickname: string;
    try {
      nickname = normalizeNickname(nicknameInput);
      assertUniqueNickname(nickname, s.players.map((p) => p.nickname));
    } catch (e) {
      throw new GameError(422, (e as Error).message);
    }
    const player: Player = {
      id: (identity.kind === 'clerk' ? 'u_' : 'g_') + this.random.id().slice(0, 20),
      nickname,
      kind: identity.kind,
      ...(identity.kind === 'clerk' && identity.userID ? { userID: identity.userID } : {}),
      joinSeq: s.nextJoinSeq++,
      joinedAt: now,
      connected: false,
      disconnectedAt: now,
      ready: false,
      deck: { photos: 0, videos: 0 },
      score: 0,
      streak: 0,
      bestStreak: 0,
      correctMs: 0,
      correctCount: 0,
    };
    s.players.push(player);
    if (!s.hostID) s.hostID = player.id;
    if (!s.players.some((p) => p.connected)) s.emptySince = now;
    s.lastActivityAt = now;
    return player;
  }

  connect(id: string, now: number) {
    const p = this.require(id);
    p.connected = true;
    p.disconnectedAt = null;
    this.state.emptySince = null;
    this.state.lastActivityAt = now;
  }

  disconnect(id: string, now: number) {
    const p = this.player(id);
    if (!p || !p.connected) return;
    p.connected = false;
    p.disconnectedAt = now;
    if (!this.state.players.some((x) => x.connected)) this.state.emptySince = now;
    this.reassignSlotsFor(id, now);
    if (this.state.phase === 'reveal') this.finishIfEveryoneGuessed(now);
  }

  /** Host moves to the longest-present connected player, else the longest-present player. */
  private transferHost() {
    const others = this.state.players.filter((p) => p.id !== this.state.hostID).sort((a, b) => a.joinSeq - b.joinSeq);
    const next = others.find((p) => p.connected) ?? (this.player(this.state.hostID ?? '') ? undefined : others[0]);
    if (next) this.state.hostID = next.id;
    else if (!this.player(this.state.hostID ?? '')) this.state.hostID = null;
  }

  leave(id: string, now: number) {
    const s = this.state;
    const p = this.player(id);
    if (!p) return;
    s.players = s.players.filter((x) => x.id !== id);
    this.removed.push(id);
    if (s.round) s.round.guessers = s.round.guessers.filter((g) => g !== id);
    if (s.hostID === id) {
      const next = [...s.players].sort((a, b) => Number(b.connected) - Number(a.connected) || a.joinSeq - b.joinSeq)[0];
      s.hostID = next?.id ?? null;
    }
    s.lastActivityAt = now;
    if (!s.players.length) return this.close();
    // Any turn that was waiting on the leaver moves on to someone else.
    this.reassignSlotsFor(id, now);
    if (!s.players.some((x) => x.connected)) s.emptySince ??= now;
    if (s.phase === 'countdown' || s.phase === 'reveal' || s.phase === 'results') {
      if (s.players.length < MIN_PLAYERS) return this.endGame(now);
      if (s.phase === 'reveal') this.finishIfEveryoneGuessed(now);
    }
  }

  // ---- lobby ----

  /** Clients report their local deck size (allowed in any phase). */
  setDeck(id: string, photos: unknown, videos: unknown, now: number) {
    const p = this.require(id);
    if (!intIn(photos, { min: 0, max: DECK_MAX }) || !intIn(videos, { min: 0, max: DECK_MAX }))
      throw new GameError(422, `Deck counts must be 0–${DECK_MAX}.`);
    p.deck = { photos, videos };
    if (p.ready && !this.bunchFits(p.deck)) p.ready = false;
    this.state.lastActivityAt = now;
  }

  setReady(id: string, ready: boolean, now: number) {
    const p = this.require(id);
    if (this.state.phase !== 'lobby') throw new GameError(409, 'You can only ready up in the lobby.');
    if (ready) {
      const need = deckNeed(p.deck, this.state.settings.mediaMode);
      if (need) throw new GameError(422, `${need} before you ready up.`);
    }
    p.ready = ready;
    this.state.lastActivityAt = now;
  }

  updateSettings(id: string, patch: Partial<Record<keyof Settings, unknown>>, now: number) {
    this.requireHost(id);
    const s = this.state;
    if (s.phase !== 'lobby') throw new GameError(409, 'Change settings in the lobby.');
    const next = { ...s.settings };
    if (patch.rounds !== undefined) {
      if (!intIn(patch.rounds, ROUNDS)) throw new GameError(422, `Rounds must be ${ROUNDS.min}–${ROUNDS.max}.`);
      next.rounds = patch.rounds;
    }
    if (patch.timerSeconds !== undefined) {
      if (!intIn(patch.timerSeconds, TIMER_SECONDS)) throw new GameError(422, `The timer must be ${TIMER_SECONDS.min}–${TIMER_SECONDS.max} seconds.`);
      next.timerSeconds = patch.timerSeconds;
    }
    if (patch.mediaMode !== undefined) {
      if (!MEDIA_MODES.includes(patch.mediaMode as MediaMode)) throw new GameError(422, 'Choose Photos, Videos, or Both.');
      next.mediaMode = patch.mediaMode as MediaMode;
    }
    if (patch.breakSeconds !== undefined) {
      if (!intIn(patch.breakSeconds, BREAK_SECONDS)) throw new GameError(422, `Break must be ${BREAK_SECONDS.min}–${BREAK_SECONDS.max} seconds.`);
      next.breakSeconds = patch.breakSeconds;
    }
    if (patch.swaps !== undefined) {
      if (!intIn(patch.swaps, SWAPS)) throw new GameError(422, `Swaps must be ${SWAPS.min}–${SWAPS.max}.`);
      next.swaps = patch.swaps;
    }
    s.settings = next;
    // Anyone whose deck no longer fits the mode must add more before readying.
    for (const p of s.players) if (p.ready && !this.bunchFits(p.deck)) p.ready = false;
    s.lastActivityAt = now;
  }

  // ---- slots ----

  /** Finished rounds owned this game plus open slots owned now. */
  private ownedRounds(id: string) {
    const s = this.state;
    return (s.owned[id] ?? 0) + s.slots.filter((slot) => slot.ownerID === id).length;
  }

  /**
   * Fewest rounds owned so far, avoiding the other open slot's owner and the
   * previous round's owner when possible, then random. Players already tried
   * for this round are excluded.
   *
   * A player only needs one item of the round's kind to be asked: a bunch that
   * has shrunk since the lobby (a pool that ran dry) can still supply a round.
   * The full-bunch rule gates readying up and starting, not mid-game turns.
   */
  private pickOwner(round: number, tried: string[]): string | null {
    const s = this.state;
    const kind = this.kindForRound(round);
    const eligible = s.players.filter((p) => p.connected && this.hasKind(p.deck, kind) && !tried.includes(p.id));
    if (!eligible.length) return null;
    const fewest = Math.min(...eligible.map((p) => this.ownedRounds(p.id)));
    let pool = eligible.filter((p) => this.ownedRounds(p.id) === fewest);
    const avoid = new Set(s.slots.filter((slot) => slot.round !== round).map((slot) => slot.ownerID));
    const previous = s.slots.find((slot) => slot.round === round - 1)?.ownerID ?? (s.lastResult?.index === round - 1 ? s.lastOwnerID : null);
    if (previous) avoid.add(previous);
    const preferred = pool.filter((p) => !avoid.has(p.id));
    if (preferred.length) pool = preferred;
    return pool[Math.floor(this.random.float() * pool.length)].id;
  }

  private requestTurn(slot: Slot) {
    this.turnRequests.push({
      playerID: slot.ownerID,
      slot: slot.id,
      game: this.state.game,
      round: slot.round,
      mode: this.state.settings.mediaMode,
      kind: slot.requiredKind,
    });
  }

  private createSlot(round: number, now: number): Slot | null {
    const ownerID = this.pickOwner(round, []);
    if (!ownerID) return null;
    const slot: Slot = {
      id: this.random.id(),
      round,
      ownerID,
      status: 'requested',
      requestedAt: now,
      requiredKind: this.kindForRound(round),
      attempts: 0,
      readyAt: null,
      tried: [],
    };
    this.state.slots.push(slot);
    this.requestTurn(slot);
    return slot;
  }

  /** The round's owner uploaded its item. Throws 409 when the turn has moved on. */
  markReady(id: string, slotID: string, kind: MediaKind, now: number): Slot {
    this.require(id);
    const s = this.state;
    const slot = s.slots.find((sl) => sl.id === slotID);
    if (!slot || slot.status !== 'requested' || slot.ownerID !== id) throw new GameError(409, 'That turn has already ended.');
    // The owner must supply the round's kind; the slot stays requested otherwise.
    if (kind !== slot.requiredKind) throw new GameError(422, slot.requiredKind === 'photo' ? 'This round needs a photo.' : 'This round needs a video.');
    slot.status = 'ready';
    slot.kind = kind;
    slot.readyAt = now;
    this.syncCountdown(slot);
    s.lastActivityAt = now;
    return slot;
  }

  private syncCountdown(slot: Slot) {
    const s = this.state;
    if (s.phase !== 'countdown' || !s.round || s.round.slotID !== slot.id || slot.readyAt === null) return;
    // While paused the upload is accepted but the deadline is set on resume.
    if (this.paused) return;
    s.phaseEndsAt = Math.max(s.round.countdownStart + COUNTDOWN_MS, slot.readyAt + MEDIA_SETTLE_MS);
  }

  /** The owner cannot supply an item; ask someone else, or give up on the game. */
  pass(id: string, slotID: string, now: number) {
    this.require(id);
    const slot = this.state.slots.find((sl) => sl.id === slotID);
    // A pass that arrives after the turn moved on (timeout, reassign) is
    // harmless; ignore it quietly so nothing reaches the owner's screen.
    if (!slot || slot.status !== 'requested' || slot.ownerID !== id) return;
    this.tried(slot, id);
    this.reassign(slot, now);
  }

  private tried(slot: Slot, id: string) {
    if (!slot.tried.includes(id)) slot.tried.push(id);
    slot.attempts = slot.tried.length;
  }

  private reassign(slot: Slot, now: number) {
    const ownerID = this.pickOwner(slot.round, slot.tried);
    if (!ownerID) return this.giveUp(slot, now);
    slot.ownerID = ownerID;
    slot.status = 'requested';
    slot.requestedAt = now;
    slot.kind = undefined;
    slot.readyAt = null;
    const s = this.state;
    if (s.round?.slotID === slot.id) s.round.ownerID = ownerID;
    s.lastActivityAt = now;
    this.requestTurn(slot);
  }

  private reassignSlotsFor(playerID: string, now: number) {
    const waiting = this.state.slots.filter((slot) => slot.status === 'requested' && slot.ownerID === playerID);
    for (const slot of waiting) {
      if (!this.state.slots.includes(slot)) continue;
      this.tried(slot, playerID);
      this.reassign(slot, now);
    }
  }

  /**
   * Nobody eligible is left for this round's item. A round that has not begun
   * cannot be played, so the game ends now; a round already showing plays out
   * and the missing next slot ends the game when it would have started.
   */
  private giveUp(slot: Slot, now: number) {
    const s = this.state;
    s.slots = s.slots.filter((sl) => sl.id !== slot.id);
    this.freedSlots.push(slot.id);
    const current = s.round?.slotID === slot.id;
    if (current || s.phase === 'results') return this.endGame(now);
    s.lastActivityAt = now;
  }

  // ---- game ----

  start(id: string, now: number) {
    this.requireHost(id);
    const blocker = this.startBlocker();
    if (blocker) throw new GameError(409, blocker);
    const s = this.state;
    clearPause(s);
    for (const p of s.players) Object.assign(p, { score: 0, streak: 0, bestStreak: 0, correctMs: 0, correctCount: 0 });
    s.slots = [];
    s.owned = {};
    s.lastOwnerID = null;
    s.lastResult = null;
    s.totalRounds = s.settings.rounds;
    // Decide every round's kind up front so photos and videos are balanced.
    s.roundKinds = balancedRoundKinds(s.totalRounds, s.settings.mediaMode, this.random);
    s.lastActivityAt = now;
    for (let round = 1; round <= Math.min(s.totalRounds, LOOKAHEAD); round++) this.createSlot(round, now);
    this.beginRound(1, now);
  }

  private beginRound(index: number, now: number) {
    const s = this.state;
    if (s.players.length < MIN_PLAYERS) return this.endGame(now);
    const slot = this.slotForRound(index);
    if (!slot) return this.endGame(now);
    s.round = {
      index,
      slotID: slot.id,
      ownerID: slot.ownerID,
      kind: null,
      countdownStart: now,
      revealAt: null,
      endsAt: null,
      guessers: [],
      guesses: {},
    };
    s.phase = 'countdown';
    s.phaseEndsAt = slot.readyAt === null ? null : Math.max(now + COUNTDOWN_MS, slot.readyAt + MEDIA_SETTLE_MS);
  }

  guess(id: string, targetID: unknown, now: number) {
    this.require(id);
    this.requireRunning();
    const s = this.state;
    const round = s.round;
    if (s.phase !== 'reveal' || !round || round.revealAt === null || round.endsAt === null) throw new GameError(409, 'There is nothing to guess right now.');
    if (!round.guessers.includes(id)) throw new GameError(409, 'You joined after this round started.');
    if (round.guesses[id]) throw new GameError(409, 'You already guessed.');
    if (now > round.endsAt) throw new GameError(409, 'Time is up.');
    if (typeof targetID !== 'string' || !s.players.some((p) => p.id === targetID)) throw new GameError(422, 'Pick a player.');
    round.guesses[id] = { targetID, elapsedMs: Math.max(0, now - round.revealAt) };
    s.lastActivityAt = now;
    this.finishIfEveryoneGuessed(now);
  }

  private finishIfEveryoneGuessed(now: number) {
    const s = this.state;
    // A round must not finish while paused; resume runs this again.
    if (this.paused) return;
    const round = s.round;
    if (s.phase !== 'reveal' || !round) return;
    const waiting = round.guessers.filter((g) => !round.guesses[g] && this.player(g)?.connected);
    if (!waiting.length) this.finishRound(now);
  }

  private finishRound(now: number) {
    const s = this.state;
    const round = s.round!;
    const timerMs = s.settings.timerSeconds * 1000;
    const rows: (ResultRow & { joinSeq: number })[] = [];
    for (const guesserID of round.guessers) {
      const p = this.player(guesserID);
      if (!p) continue;
      const g = round.guesses[guesserID];
      // The owner guesses too so nobody can tell whose item it is, but they
      // always know their own: their guess is a decoy that scores nothing and
      // leaves their streak alone.
      if (guesserID === round.ownerID) {
        rows.push({ playerID: p.id, targetID: g?.targetID ?? null, correct: g?.targetID === round.ownerID, points: 0, accuracy: 0, speed: 0, streakBonus: 0, streak: p.streak, elapsedMs: g?.elapsedMs ?? null, total: p.score, joinSeq: p.joinSeq });
        continue;
      }
      const result = scoreGuess({ correct: g?.targetID === round.ownerID, elapsedMs: g?.elapsedMs ?? null, timerMs, previousStreak: p.streak });
      p.score += result.points;
      p.streak = result.streak;
      p.bestStreak = Math.max(p.bestStreak, result.streak);
      if (result.correct) {
        p.correctMs += g!.elapsedMs;
        p.correctCount += 1;
      }
      rows.push({ playerID: p.id, targetID: g?.targetID ?? null, elapsedMs: g?.elapsedMs ?? null, total: p.score, joinSeq: p.joinSeq, ...result });
    }
    s.lastResult = { index: round.index, ownerID: round.ownerID, kind: round.kind ?? 'photo', rows: rankRound(rows).map(({ joinSeq: _, ...row }) => row) };
    // The round's media is no longer needed: the Durable Object drops the bytes.
    s.slots = s.slots.filter((sl) => sl.id !== round.slotID);
    s.owned = { ...s.owned, [round.ownerID]: (s.owned[round.ownerID] ?? 0) + 1 };
    s.lastOwnerID = round.ownerID;
    this.freedSlots.push(round.slotID);
    s.round = null;
    s.phase = 'results';
    s.phaseEndsAt = now + s.settings.breakSeconds * 1000;
  }

  /** Host skips the rest of the results pause. */
  advance(id: string, now: number) {
    this.requireHost(id);
    this.requireRunning();
    if (this.state.phase !== 'results') throw new GameError(409, 'Nothing to skip right now.');
    this.state.phaseEndsAt = now;
    this.tick(now);
  }

  /** Host ends the current game early and goes to the podium. */
  end(id: string, now: number) {
    this.requireHost(id);
    const p = this.state.phase;
    if (p !== 'countdown' && p !== 'reveal' && p !== 'results') throw new GameError(409, 'No game is running.');
    this.endGame(now);
  }

  // ---- pause ----
  // The timing rules live in pause.ts; this is the game's policy around them.

  /** Whether the host has frozen the phase clock. */
  get paused() {
    return this.state.pausedAt !== null;
  }

  /** Host freezes the current phase. Guests keep their seats and uploads still land. */
  pause(id: string, now: number) {
    this.requireHost(id);
    const phase = this.state.phase;
    if (this.paused) throw new GameError(409, 'The game is already paused.');
    if (phase !== 'countdown' && phase !== 'reveal' && phase !== 'results') throw new GameError(409, 'There is nothing to pause right now.');
    beginPause(this.state, now);
    this.state.lastActivityAt = now;
  }

  /** Host unfreezes the phase, shifting round timers past the paused time. */
  resume(id: string, now: number) {
    this.requireHost(id);
    if (!this.paused) throw new GameError(409, 'The game is not paused.');
    this.resumeFromPause(now);
  }

  /** Shared by the host's resume and by a pause that timed out. */
  private resumeFromPause(now: number) {
    endPause(this.state, now, COUNTDOWN_MS);
    this.state.lastActivityAt = now;
    // A reveal may have lost its last waiting guesser while paused.
    this.finishIfEveryoneGuessed(now);
  }

  private requireRunning() {
    if (this.paused) throw new GameError(409, 'The game is paused.');
  }

  private endGame(now: number) {
    const s = this.state;
    clearPause(s);
    for (const slot of s.slots) this.freedSlots.push(slot.id);
    s.slots = [];
    s.round = null;
    s.phase = 'podium';
    s.phaseEndsAt = null;
    for (const p of s.players) p.ready = false;
    s.lastActivityAt = now;
  }

  playAgain(id: string, now: number) {
    this.requireHost(id);
    const s = this.state;
    if (s.phase !== 'podium') throw new GameError(409, 'Finish this game first.');
    clearPause(s);
    s.phase = 'lobby';
    s.game += 1;
    s.lastResult = null;
    s.totalRounds = 0;
    s.slots = [];
    for (const p of s.players) Object.assign(p, { ready: false, score: 0, streak: 0, bestStreak: 0, correctMs: 0, correctCount: 0 });
    s.lastActivityAt = now;
  }

  close() {
    clearPause(this.state);
    for (const slot of this.state.slots) this.freedSlots.push(slot.id);
    this.state.slots = [];
    this.state.round = null;
    this.state.phase = 'closed';
    this.state.phaseEndsAt = null;
  }

  // ---- time ----

  /** Applies every timeout, transition, and cleanup that is due at `now`. */
  tick(now: number) {
    const s = this.state;
    // A pause that outlives the host's patience ends by itself.
    if (s.pausedAt !== null && now >= s.pausedAt + PAUSE_MAX_MS) this.resumeFromPause(now);
    // Re-pick timeouts are deadlines like any other.
    for (const slot of [...s.slots].filter((sl) => sl.status === 'requested' && now >= sl.requestedAt + UPLOAD_TIMEOUT_MS)) {
      if (!s.slots.includes(slot)) continue;
      this.tried(slot, slot.ownerID);
      this.reassign(slot, now);
    }
    for (let guard = 0; guard < 100 && s.phase !== 'closed'; guard++) {
      // While paused there is no phase deadline, and nothing may advance.
      if (this.paused) break;
      if (s.phaseEndsAt === null || now < s.phaseEndsAt) break;
      if (s.phase === 'countdown' && s.round) {
        const round = s.round;
        const slot = this.slotForRound(round.index);
        if (!slot || slot.status !== 'ready') {
          // Still waiting for the upload; the timeout above will re-pick.
          s.phaseEndsAt = null;
          break;
        }
        // The reveal begins when this tick runs, not when the countdown was
        // due: a late alarm (hibernation, deploy) must still give the round its
        // full time rather than skipping it.
        round.kind = slot.requiredKind;
        round.revealAt = now;
        round.endsAt = now + s.settings.timerSeconds * 1000;
        round.guessers = s.players.filter((p) => p.connected).map((p) => p.id);
        s.phase = 'reveal';
        s.phaseEndsAt = round.endsAt;
        // One round of lookahead: the next round's item is requested now.
        if (round.index + 1 <= s.totalRounds && !this.slotForRound(round.index + 1)) this.createSlot(round.index + 1, now);
        this.finishIfEveryoneGuessed(now);
      } else if (s.phase === 'reveal' && s.round) {
        this.finishRound(now);
      } else if (s.phase === 'results') {
        const next = (s.lastResult?.index ?? 0) + 1;
        if (next > s.totalRounds) this.endGame(now);
        else this.beginRound(next, now);
      } else s.phaseEndsAt = null;
    }
    if (s.phase === 'closed') return;
    const hostGrace = this.hostGraceDeadline();
    if (hostGrace !== null && now >= hostGrace) this.transferHost();
    for (const p of [...s.players]) if (!p.connected && p.disconnectedAt !== null && now >= p.disconnectedAt + DISCONNECT_GRACE_MS) this.leave(p.id, now);
    if (this.state.phase === 'closed') return;
    if (s.emptySince !== null && now >= s.emptySince + EMPTY_ROOM_GRACE_MS) return this.close();
    const idle = this.idleDeadline();
    if (idle !== null && now >= idle) this.close();
  }

  /** When a dropped host's role moves on, if it still can (someone else is connected). */
  private hostGraceDeadline() {
    const s = this.state;
    const host = this.player(s.hostID ?? '');
    if (!host || host.connected || host.disconnectedAt === null) return null;
    return s.players.some((p) => p.connected) ? host.disconnectedAt + HOST_GRACE_MS : null;
  }

  private idleDeadline() {
    const s = this.state;
    if (s.phase === 'podium') return s.lastActivityAt + FINISHED_ROOM_GRACE_MS;
    if (s.phase === 'lobby') return s.lastActivityAt + IDLE_ROOM_MS;
    return null;
  }

  /** The next time `tick` has work to do, for the Durable Object alarm. */
  nextDeadline(): number | null {
    const s = this.state;
    if (s.phase === 'closed') return null;
    const times = [
      s.phaseEndsAt,
      s.pausedAt === null ? null : s.pausedAt + PAUSE_MAX_MS,
      s.emptySince === null ? null : s.emptySince + EMPTY_ROOM_GRACE_MS,
      this.idleDeadline(),
      ...s.players.map((p) => (p.connected || p.disconnectedAt === null ? null : p.disconnectedAt + DISCONNECT_GRACE_MS)),
      this.hostGraceDeadline(),
      ...s.slots.filter((slot) => slot.status === 'requested').map((slot) => slot.requestedAt + UPLOAD_TIMEOUT_MS),
    ].filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }

  // ---- views ----

  /** What one player is allowed to see. Never includes slots, owner ids before results, or other players' guesses. */
  view(viewerID: string, now: number) {
    const s = this.state;
    const round = s.round;
    const ranked = s.phase === 'podium' ? rankFinal(s.players) : [];
    return {
      code: s.code,
      phase: s.phase,
      game: s.game,
      hostID: s.hostID,
      capacity: CAPACITY,
      settings: s.settings,
      serverNow: now,
      phaseEndsAt: s.phaseEndsAt,
      paused: this.paused,
      pausedRemainingMs: s.pausedRemainingMs,
      startBlocker: s.phase === 'lobby' ? this.startBlocker(viewerID) : null,
      players: [...s.players]
        .sort((a, b) => a.joinSeq - b.joinSeq)
        .map((p) => ({
          id: p.id,
          nickname: p.nickname,
          signedIn: p.kind === 'clerk',
          isHost: p.id === s.hostID,
          ready: p.ready,
          connected: p.connected,
          score: p.score,
          streak: p.streak,
          deck: { photos: p.deck.photos, videos: p.deck.videos },
        })),
      you: { id: viewerID },
      round:
        round && s.phase === 'countdown'
          ? // `waiting` is about the media, not the clock: a paused countdown
            // whose upload already landed is not "Shuffling…".
            { index: round.index, total: s.totalRounds, waiting: this.slotForRound(round.index)?.status !== 'ready' }
          : round && s.phase === 'reveal'
            ? {
                index: round.index,
                total: s.totalRounds,
                kind: round.kind,
                revealAt: round.revealAt,
                endsAt: round.endsAt,
                canGuess: round.guessers.includes(viewerID) && !round.guesses[viewerID],
                yourGuess: round.guesses[viewerID]?.targetID ?? null,
                guessedCount: Object.keys(round.guesses).length,
                guesserCount: round.guessers.length,
              }
            : s.phase === 'results' || s.phase === 'podium'
              ? { index: s.lastResult?.index ?? 0, total: s.totalRounds }
              : null,
      lastResult: s.phase === 'results' || s.phase === 'podium' ? s.lastResult : null,
      podium: ranked.map((p, i) => ({ playerID: p.id, rank: i + 1, score: p.score, bestStreak: p.bestStreak, correctCount: p.correctCount })),
    };
  }
}

export type RoomView = ReturnType<Game['view']>;
