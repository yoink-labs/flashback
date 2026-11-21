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
// player's local bunch is full for the room's `bunch` requirement.
//
// Milestone 3 adds host pause/resume, a host-set break length between rounds,
// and a balanced photo/video kind for every round, decided at start.
//
// Milestone 4 adds Even Split (a fixed schedule, live bunch sizing), streak and
// round effects, 50/50, and the between-rounds shop. The pure rules live in
// settings.ts, effects.ts, shop.ts, schedule.ts, bunch.ts and state.ts; this
// file is the game's policy and orchestration.
import { balancedRoundKinds, bunchFor, deckFits, deckNeed, type Deck } from './bunch';
import { roundEffectFor, sharpEyesBonus, streakEffectFor } from './effects';
import { GameError } from './errors';
import { type MediaKind } from './media';
import { assertUniqueNickname, normalizeNickname } from './nickname';
import { beginPause, clearPause, endPause } from './pause';
import { pickSome } from './random';
import { evenSplitSchedule } from './schedule';
import { rankRound, scoreGuess } from './scoring';
import { applySettingsPatch, type Settings } from './settings';
import { buyItem, DOUBLE_DOWN_PENALTY, emptyItems, MAX_FIFTY_FIFTY, resultsBreakSeconds, shopOpenFor } from './shop';
import {
  CAPACITY,
  MIN_PLAYERS,
  newRoom,
  normalizeRoom,
  type DoubleDownOutcome,
  type Player,
  type ResultRow,
  type RoomState,
  type RoundState,
  type Slot,
  type TurnRequest,
} from './state';
import { roomView } from './view';

export { GameError } from './errors';
export { CAPACITY, MIN_PLAYERS } from './state';
export { ROUNDS, TIMER_SECONDS, BREAK_SECONDS, SWAPS, MEDIA_MODES } from './settings';
export type { Settings } from './settings';
export { SHOP_MIN_BREAK_SECONDS, SHOP_PRICES } from './shop';
export { newRoom, normalizeRoom } from './state';
export type { Phase, Player, Slot, Guess, RoundState, ResultRow, RoundResult, TurnRequest, RoomState } from './state';
export type { RoomView } from './view';

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
export const DECK_MAX = 500;

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

const intIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

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

  /** How many of each kind every player must deal right now (docs/MILESTONE4.md §2). */
  bunch() {
    const s = this.state;
    return bunchFor(s.settings.mediaMode, s.settings.evenSplit, s.settings.rounds, s.players.length);
  }

  private bunchFits(deck: Deck) {
    return deckFits(deck, this.bunch());
  }

  /** Whether the deck still has an item of the round's kind to offer. */
  private hasKind(deck: Deck, kind: MediaKind) {
    return kind === 'photo' ? deck.photos > 0 : deck.videos > 0;
  }

  private slotForRound(round: number) {
    return this.state.slots.find((slot) => slot.round === round);
  }

  /** The kind round N plays: the Even Split schedule, else the balanced list. */
  private kindForRound(round: number): MediaKind {
    return this.state.schedule?.[round - 1]?.kind ?? this.state.roundKinds[round - 1] ?? (this.state.settings.mediaMode === 'videos' ? 'video' : 'photo');
  }

  /**
   * Why the host cannot start yet, worded for one viewer (default: the host),
   * or null if they can. "You" when it is the viewer's own deck or Ready.
   */
  startBlocker(viewerID: string | null = this.state.hostID): string | null {
    const s = this.state;
    if (s.phase !== 'lobby') return 'A game is already running.';
    if (s.players.length < MIN_PLAYERS) return 'Waiting for players';
    const bunch = this.bunch();
    for (const p of s.players) {
      const need = deckNeed(p.deck, bunch);
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
      missStreak: 0,
      bestStreak: 0,
      correctMs: 0,
      correctCount: 0,
      items: emptyItems(),
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
    // Readiness is kept when the bunch requirement grows (Even Split follows
    // the player count): the start blocker simply waits until the deck fits.
    this.state.lastActivityAt = now;
  }

  setReady(id: string, ready: boolean, now: number) {
    const p = this.require(id);
    if (this.state.phase !== 'lobby') throw new GameError(409, 'You can only ready up in the lobby.');
    if (ready) {
      const need = deckNeed(p.deck, this.bunch());
      if (need) throw new GameError(422, `${need} before you ready up.`);
    }
    p.ready = ready;
    this.state.lastActivityAt = now;
  }

  updateSettings(id: string, patch: Partial<Record<keyof Settings, unknown>>, now: number) {
    this.requireHost(id);
    const s = this.state;
    if (s.phase !== 'lobby') throw new GameError(409, 'Change settings in the lobby.');
    s.settings = applySettingsPatch(s.settings, patch);
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

  /**
   * The Even Split schedule's owner if they can still supply this round;
   * otherwise the normal fewest-owned pick, keeping the scheduled kind.
   */
  private scheduledOwner(round: number, kind: MediaKind): string | null {
    const scheduled = this.state.schedule?.[round - 1];
    if (!scheduled) return null;
    const player = this.player(scheduled.ownerID);
    if (!player || !player.connected || !this.hasKind(player.deck, kind)) return null;
    return player.id;
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
    const kind = this.kindForRound(round);
    const ownerID = this.scheduledOwner(round, kind) ?? this.pickOwner(round, []);
    if (!ownerID) return null;
    const slot: Slot = {
      id: this.random.id(),
      round,
      ownerID,
      status: 'requested',
      requestedAt: now,
      requiredKind: kind,
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
    for (const p of s.players) Object.assign(p, { score: 0, streak: 0, missStreak: 0, bestStreak: 0, correctMs: 0, correctCount: 0, items: emptyItems() });
    s.slots = [];
    s.owned = {};
    s.lastOwnerID = null;
    s.lastResult = null;
    s.totalRounds = s.settings.rounds;
    s.shopBought = {};
    // Even Split fixes who owns every round (and of what kind) up front. Without
    // it the M3 behaviour stands: balanced kinds, owners picked as rounds open.
    if (s.settings.evenSplit) {
      s.schedule = evenSplitSchedule(s.totalRounds, s.players, s.settings.mediaMode, this.random);
      s.roundKinds = [];
    } else {
      s.schedule = null;
      s.roundKinds = balancedRoundKinds(s.totalRounds, s.settings.mediaMode, this.random);
    }
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
      effect: null,
      streakEffects: {},
      eliminated: {},
      fiftyFiftyUsed: {},
    };
    s.phase = 'countdown';
    s.phaseEndsAt = slot.readyAt === null ? null : Math.max(now + COUNTDOWN_MS, slot.readyAt + MEDIA_SETTLE_MS);
  }

  /** Decides the round-wide and every private effect the moment a reveal begins. */
  private decideEffects(round: RoundState, now: number) {
    const s = this.state;
    round.kind = this.slotForRound(round.index)?.requiredKind ?? round.kind;
    round.revealAt = now;
    round.endsAt = now + s.settings.timerSeconds * 1000;
    round.guessers = s.players.filter((p) => p.connected).map((p) => p.id);
    round.effect = roundEffectFor(s.settings.effects, s.settings.timerSeconds, this.random);
    round.streakEffects = {};
    for (const guesserID of round.guessers) {
      if (guesserID === round.ownerID) continue;
      const p = this.player(guesserID);
      if (!p) continue;
      const effect = streakEffectFor(s.settings.effects, p.streak, p.missStreak);
      if (effect) round.streakEffects[guesserID] = effect;
    }
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
    if (round.eliminated[id]?.includes(targetID)) throw new GameError(422, 'Your 50/50 ruled that player out.');
    round.guesses[id] = { targetID, elapsedMs: Math.max(0, now - round.revealAt) };
    s.lastActivityAt = now;
    this.finishIfEveryoneGuessed(now);
  }

  /** Spends a held 50/50 to grey out half the wrong choices (docs/MILESTONE4.md §5). */
  useFiftyFifty(id: string, now: number) {
    this.require(id);
    this.requireRunning();
    const s = this.state;
    const round = s.round;
    if (s.phase !== 'reveal' || !round || !round.guessers.includes(id) || round.guesses[id])
      throw new GameError(409, "You can't use a 50/50 right now.");
    const p = this.player(id)!;
    if (p.items.fiftyFifty < 1) throw new GameError(409, "You don't have a 50/50.");
    if (round.fiftyFiftyUsed[id]) throw new GameError(409, 'You already used a 50/50 this round.');
    // Wrong choices are every other player except the round's owner: the list
    // never gives the owner away, and never wastes a cut on the viewer, who
    // already knows the item isn't theirs. With fewer than two there's nothing
    // to cut, so the charge is kept.
    const wrong = s.players.filter((other) => other.id !== round.ownerID && other.id !== id).map((other) => other.id);
    const cut = Math.floor(wrong.length / 2);
    if (cut === 0) throw new GameError(409, 'There is nobody to cut this round.');
    p.items.fiftyFifty -= 1;
    round.fiftyFiftyUsed[id] = true;
    round.eliminated[id] = pickSome(wrong, cut, this.random);
    s.lastActivityAt = now;
  }

  /** Buys one shop item during a break (docs/MILESTONE4.md §6). */
  buy(id: string, item: unknown, now: number) {
    this.require(id);
    const s = this.state;
    if (
      !shopOpenFor({
        shopEnabled: s.settings.powerups.shop.enabled,
        phase: s.phase,
        paused: this.paused,
        lastResultIndex: s.lastResult?.index ?? null,
        totalRounds: s.totalRounds,
      })
    )
      throw new GameError(409, 'The shop is closed.');
    if (s.shopBought[id]) throw new GameError(409, 'One buy per break.');
    buyItem(this.player(id)!, item);
    s.shopBought[id] = true;
    s.lastActivityAt = now;
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
    const roundEffect = round.effect?.kind ?? null;
    const fiftyFiftySetting = s.settings.powerups.fiftyFifty;
    const rows: (ResultRow & { joinSeq: number })[] = [];
    for (const guesserID of round.guessers) {
      const p = this.player(guesserID);
      if (!p) continue;
      const g = round.guesses[guesserID];
      const usedFiftyFifty = round.fiftyFiftyUsed[guesserID] === true;
      // The owner guesses too so nobody can tell whose item it is, but they
      // always know their own: their guess is a decoy that scores nothing and
      // leaves their streaks alone. A 50/50 spent on their own round comes back.
      if (guesserID === round.ownerID) {
        if (usedFiftyFifty) p.items.fiftyFifty = Math.min(MAX_FIFTY_FIFTY, p.items.fiftyFifty + 1);
        rows.push({
          playerID: p.id,
          targetID: g?.targetID ?? null,
          correct: g?.targetID === round.ownerID,
          points: 0,
          accuracy: 0,
          speed: 0,
          streakBonus: 0,
          streak: p.streak,
          elapsedMs: g?.elapsedMs ?? null,
          total: p.score,
          bonus: 0,
          doubleDown: p.items.doubleDown > 0 ? 'refunded' : null,
          shielded: false,
          effect: null,
          roundEffect,
          fiftyFifty: usedFiftyFifty,
          earnedFiftyFifty: false,
          joinSeq: p.joinSeq,
        });
        continue;
      }
      const correct = g?.targetID === round.ownerID;
      const base = scoreGuess({ correct, elapsedMs: g?.elapsedMs ?? null, timerMs, previousStreak: p.streak });
      const bonus = correct ? sharpEyesBonus(round.effect, g!.elapsedMs) : 0;
      let points = base.points + bonus;
      let doubleDown: DoubleDownOutcome = null;
      if (p.items.doubleDown > 0) {
        p.items.doubleDown = 0;
        if (correct) {
          points = (base.points + bonus) * 2;
          doubleDown = 'won';
        } else {
          points = -DOUBLE_DOWN_PENALTY;
          doubleDown = 'lost';
        }
      }
      // Shield is spent by a miss, and only by a miss: it keeps both streaks.
      const shielded = !correct && p.items.shield > 0;
      if (shielded) p.items.shield = 0;
      if (correct) {
        p.streak = base.streak;
        p.missStreak = 0;
        p.bestStreak = Math.max(p.bestStreak, p.streak);
        p.correctMs += g!.elapsedMs;
        p.correctCount += 1;
      } else if (!shielded) {
        p.streak = 0;
        p.missStreak += 1;
      }
      // Penalties clamp at 0; the row carries the delta actually applied.
      const before = p.score;
      p.score = Math.max(0, p.score + points);
      points = p.score - before;
      let earnedFiftyFifty = false;
      if (fiftyFiftySetting.enabled && correct && base.streak > 0 && base.streak % fiftyFiftySetting.after === 0 && p.items.fiftyFifty < MAX_FIFTY_FIFTY) {
        p.items.fiftyFifty += 1;
        earnedFiftyFifty = true;
      }
      rows.push({
        playerID: p.id,
        targetID: g?.targetID ?? null,
        correct,
        points,
        accuracy: base.accuracy,
        speed: base.speed,
        streakBonus: base.streakBonus,
        streak: p.streak,
        elapsedMs: g?.elapsedMs ?? null,
        total: p.score,
        bonus,
        doubleDown,
        shielded,
        effect: round.streakEffects[guesserID]?.kind ?? null,
        roundEffect,
        fiftyFifty: usedFiftyFifty,
        earnedFiftyFifty,
        joinSeq: p.joinSeq,
      });
    }
    s.lastResult = { index: round.index, ownerID: round.ownerID, kind: round.kind ?? 'photo', rows: rankRound(rows).map(({ joinSeq: _, ...row }) => row) };
    // The round's media is no longer needed: the Durable Object drops the bytes.
    s.slots = s.slots.filter((sl) => sl.id !== round.slotID);
    s.owned = { ...s.owned, [round.ownerID]: (s.owned[round.ownerID] ?? 0) + 1 };
    s.lastOwnerID = round.ownerID;
    this.freedSlots.push(round.slotID);
    s.round = null;
    s.phase = 'results';
    s.shopBought = {};
    s.phaseEndsAt = now + resultsBreakSeconds(s.settings, round.index >= s.totalRounds) * 1000;
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
    s.shopBought = {};
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
    s.schedule = null;
    s.roundKinds = [];
    s.shopBought = {};
    for (const p of s.players)
      Object.assign(p, { ready: false, score: 0, streak: 0, missStreak: 0, bestStreak: 0, correctMs: 0, correctCount: 0, items: emptyItems() });
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
        round.ownerID = slot.ownerID;
        this.decideEffects(round, now);
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
    return roomView(s, viewerID, now, s.phase === 'lobby' ? this.startBlocker(viewerID) : null);
  }
}
