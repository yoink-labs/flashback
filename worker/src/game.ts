// The Flashback room state machine. Pure and deterministic: time and randomness
// are passed in, and side effects (media deletions, room teardown) are returned
// for the Durable Object to perform. The Durable Object is a thin adapter.
//
// Phases: lobby → countdown → reveal → results → (countdown … | podium) → lobby
//
// Start rule (shown in the lobby UI): the host can start when at least two
// players are in the room, every player is ready, and every player has added at
// least one photo or video that fits the media mode. Players cannot ready up
// until they have added something that fits.
import { kindAllowed, ITEMS_PER_PLAYER, MEDIA_TTL_MS, type MediaKind, type MediaMode } from './media';
import { assertUniqueNickname, normalizeNickname } from './nickname';
import { rankFinal, rankRound, scoreGuess } from './scoring';

export const CAPACITY = 12;
export const MIN_PLAYERS = 2;
export const COUNTDOWN_MS = 3_000;
export const RESULTS_MS = 8_000;
/** A dropped player keeps their seat this long (app switch, fold, flaky Wi-Fi). */
export const DISCONNECT_GRACE_MS = 90_000;
/** A room with nobody connected is torn down after this. */
export const EMPTY_ROOM_GRACE_MS = 2 * 60_000;
/** Finished games (podium) with no Play Again are torn down after this. */
export const FINISHED_ROOM_GRACE_MS = 15 * 60_000;
/** Lobbies with no activity are torn down after this. */
export const IDLE_ROOM_MS = 60 * 60_000;
export const ROUNDS = { min: 1, max: 20, default: 5 } as const;
export const TIMER_SECONDS = { min: 10, max: 60, default: 20 } as const;
export const MEDIA_MODES: readonly MediaMode[] = ['photos', 'videos', 'both'];

export type Phase = 'lobby' | 'countdown' | 'reveal' | 'results' | 'podium' | 'closed';

export interface Settings {
  rounds: number;
  timerSeconds: number;
  mediaMode: MediaMode;
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
  score: number;
  streak: number;
  bestStreak: number;
  correctMs: number;
  correctCount: number;
}

export interface MediaItem {
  id: string;
  ownerID: string;
  kind: MediaKind;
  key: string;
  contentType: string;
  bytes: number;
  durationMs?: number;
  uploadedAt: number;
  expiresAt: number;
}

export interface Guess {
  targetID: string;
  elapsedMs: number;
}

export interface RoundState {
  index: number;
  itemID: string;
  ownerID: string;
  kind: MediaKind;
  /** Random capability for the media URL; valid only during this round's reveal. */
  capability: string;
  revealAt: number | null;
  endsAt: number | null;
  /** Players who may guess this round (everyone present at start except the owner). */
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

export interface RoomState {
  code: string;
  instance: string;
  createdAt: number;
  lastActivityAt: number;
  phase: Phase;
  hostID: string | null;
  settings: Settings;
  players: Player[];
  items: MediaItem[];
  game: number;
  totalRounds: number;
  round: RoundState | null;
  lastResult: RoundResult | null;
  phaseEndsAt: number | null;
  emptySince: number | null;
  nextJoinSeq: number;
  shown: Record<string, number>;
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
    settings: { rounds: ROUNDS.default, timerSeconds: TIMER_SECONDS.default, mediaMode: 'both' },
    players: [],
    items: [],
    game: 1,
    totalRounds: 0,
    round: null,
    lastResult: null,
    phaseEndsAt: null,
    emptySince: now,
    nextJoinSeq: 1,
    shown: {},
  };
}

const intIn = (value: unknown, range: { min: number; max: number }) =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

const modeLabel = (mode: MediaMode) => (mode === 'photos' ? 'a photo' : mode === 'videos' ? 'a video' : 'a photo or video');

export class Game {
  /** R2 keys to delete after this mutation. */
  deletions: string[] = [];
  /** Players removed by this mutation (their sockets should be closed). */
  removed: string[] = [];

  constructor(public state: RoomState, private random: Randomness = defaultRandomness) {}

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

  eligibleItems(ownerID?: string) {
    return this.state.items.filter((i) => kindAllowed(this.state.settings.mediaMode, i.kind) && (!ownerID || i.ownerID === ownerID));
  }

  /** Why the host cannot start yet, or null if they can. */
  startBlocker(): string | null {
    const s = this.state;
    if (s.phase !== 'lobby') return 'A game is already running.';
    if (s.players.length < MIN_PLAYERS) return 'Waiting for at least 2 players.';
    for (const p of s.players) if (!this.eligibleItems(p.id).length) return `Waiting for ${p.nickname} to add ${modeLabel(s.settings.mediaMode)}.`;
    for (const p of s.players) if (!p.ready) return `Waiting for ${p.nickname} to ready up.`;
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
    if (this.state.hostID === id) this.transferHost();
    if (!this.state.players.some((x) => x.connected)) this.state.emptySince = now;
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
    // Unused media leaves with its owner. The item on screen right now is
    // deleted when its round ends.
    for (const item of s.items.filter((i) => i.ownerID === id && i.id !== s.round?.itemID)) this.dropItem(item);
    if (s.round) s.round.guessers = s.round.guessers.filter((g) => g !== id);
    if (s.hostID === id) {
      const next = [...s.players].sort((a, b) => Number(b.connected) - Number(a.connected) || a.joinSeq - b.joinSeq)[0];
      s.hostID = next?.id ?? null;
    }
    s.lastActivityAt = now;
    if (!s.players.length) return this.close();
    if (!s.players.some((x) => x.connected)) s.emptySince ??= now;
    if (s.phase === 'countdown' || s.phase === 'reveal' || s.phase === 'results') {
      if (s.players.length < MIN_PLAYERS) return this.endGame(now);
      if (s.phase === 'reveal') this.finishIfEveryoneGuessed(now);
    }
  }

  // ---- lobby ----

  setReady(id: string, ready: boolean, now: number) {
    const p = this.require(id);
    if (this.state.phase !== 'lobby') throw new GameError(409, 'You can only ready up in the lobby.');
    if (ready && !this.eligibleItems(id).length) throw new GameError(422, `Add ${modeLabel(this.state.settings.mediaMode)} before you ready up.`);
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
      next.rounds = patch.rounds as number;
    }
    if (patch.timerSeconds !== undefined) {
      if (!intIn(patch.timerSeconds, TIMER_SECONDS)) throw new GameError(422, `The timer must be ${TIMER_SECONDS.min}–${TIMER_SECONDS.max} seconds.`);
      next.timerSeconds = patch.timerSeconds as number;
    }
    if (patch.mediaMode !== undefined) {
      if (!MEDIA_MODES.includes(patch.mediaMode as MediaMode)) throw new GameError(422, 'Choose Photos, Videos, or Both.');
      next.mediaMode = patch.mediaMode as MediaMode;
    }
    s.settings = next;
    // Anyone whose pool no longer fits the mode must add more before readying.
    for (const p of s.players) if (p.ready && !this.eligibleItems(p.id).length) p.ready = false;
    s.lastActivityAt = now;
  }

  /** Throws unless `id` may upload one more item of `kind` right now. */
  assertCanAdd(id: string, kind: MediaKind) {
    this.require(id);
    const s = this.state;
    if (s.phase !== 'lobby') throw new GameError(409, 'Add photos and videos in the lobby.');
    if (!kindAllowed(s.settings.mediaMode, kind))
      throw new GameError(422, s.settings.mediaMode === 'photos' ? 'The host chose Photos only.' : 'The host chose Videos only.');
    if (s.items.filter((i) => i.ownerID === id).length >= ITEMS_PER_PLAYER) throw new GameError(409, `You can add up to ${ITEMS_PER_PLAYER} items per game.`);
  }

  addItem(id: string, item: Omit<MediaItem, 'ownerID' | 'uploadedAt' | 'expiresAt'>, now: number): MediaItem {
    this.assertCanAdd(id, item.kind);
    const full: MediaItem = { ...item, ownerID: id, uploadedAt: now, expiresAt: now + MEDIA_TTL_MS };
    this.state.items.push(full);
    this.state.lastActivityAt = now;
    return full;
  }

  removeItem(id: string, itemID: string, now: number) {
    const p = this.require(id);
    if (this.state.phase !== 'lobby') throw new GameError(409, 'Remove items in the lobby.');
    const item = this.state.items.find((i) => i.id === itemID && i.ownerID === id);
    if (!item) throw new GameError(404, 'That item is already gone.');
    this.dropItem(item);
    if (p.ready && !this.eligibleItems(id).length) p.ready = false;
    this.state.lastActivityAt = now;
  }

  private dropItem(item: MediaItem) {
    this.state.items = this.state.items.filter((i) => i.id !== item.id);
    this.deletions.push(item.key);
  }

  // ---- game ----

  start(id: string, now: number) {
    this.requireHost(id);
    const blocker = this.startBlocker();
    if (blocker) throw new GameError(409, blocker);
    const s = this.state;
    // Items outside the media mode will never be shown; delete them now.
    for (const item of s.items.filter((i) => !kindAllowed(s.settings.mediaMode, i.kind))) this.dropItem(item);
    for (const p of s.players) Object.assign(p, { score: 0, streak: 0, bestStreak: 0, correctMs: 0, correctCount: 0 });
    s.shown = {};
    s.lastResult = null;
    s.totalRounds = Math.min(s.settings.rounds, s.items.length);
    s.lastActivityAt = now;
    this.beginRound(1, now);
  }

  /** Server-side pick: the owner shown least so far (random among ties), then a random item of theirs. */
  private pick(): MediaItem | null {
    const s = this.state;
    const owners = s.players.filter((p) => s.items.some((i) => i.ownerID === p.id)).map((p) => p.id);
    if (!owners.length) return null;
    const fewest = Math.min(...owners.map((o) => s.shown[o] ?? 0));
    const pool = owners.filter((o) => (s.shown[o] ?? 0) === fewest);
    const owner = pool[Math.floor(this.random.float() * pool.length)];
    const items = s.items.filter((i) => i.ownerID === owner);
    return items[Math.floor(this.random.float() * items.length)];
  }

  private beginRound(index: number, now: number) {
    const s = this.state;
    const item = this.pick();
    if (!item || s.players.length < MIN_PLAYERS) return this.endGame(now);
    s.shown[item.ownerID] = (s.shown[item.ownerID] ?? 0) + 1;
    s.round = {
      index,
      itemID: item.id,
      ownerID: item.ownerID,
      kind: item.kind,
      capability: this.random.id() + this.random.id(),
      revealAt: null,
      endsAt: null,
      guessers: s.players.filter((p) => p.id !== item.ownerID).map((p) => p.id),
      guesses: {},
    };
    s.phase = 'countdown';
    s.phaseEndsAt = now + COUNTDOWN_MS;
  }

  guess(id: string, targetID: unknown, now: number) {
    this.require(id);
    const s = this.state;
    const round = s.round;
    if (s.phase !== 'reveal' || !round || round.revealAt === null || round.endsAt === null) throw new GameError(409, 'There is nothing to guess right now.');
    if (id === round.ownerID) throw new GameError(409, 'This one is yours. Sit this guess out.');
    if (!round.guessers.includes(id)) throw new GameError(409, 'You joined after this round started.');
    if (round.guesses[id]) throw new GameError(409, 'You already guessed.');
    if (now > round.endsAt) throw new GameError(409, 'Time is up.');
    if (typeof targetID !== 'string' || targetID === id || !s.players.some((p) => p.id === targetID)) throw new GameError(422, 'Pick another player.');
    round.guesses[id] = { targetID, elapsedMs: Math.max(0, now - round.revealAt) };
    s.lastActivityAt = now;
    this.finishIfEveryoneGuessed(now);
  }

  private finishIfEveryoneGuessed(now: number) {
    const round = this.state.round;
    if (this.state.phase !== 'reveal' || !round) return;
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
      const result = scoreGuess({ correct: g?.targetID === round.ownerID, elapsedMs: g?.elapsedMs ?? null, timerMs, previousStreak: p.streak });
      p.score += result.points;
      p.streak = result.streak;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      if (result.correct) {
        p.correctMs += g!.elapsedMs;
        p.correctCount += 1;
      }
      rows.push({ playerID: p.id, targetID: g?.targetID ?? null, elapsedMs: g?.elapsedMs ?? null, total: p.score, joinSeq: p.joinSeq, ...result });
    }
    s.lastResult = { index: round.index, ownerID: round.ownerID, kind: round.kind, rows: rankRound(rows).map(({ joinSeq: _, ...row }) => row) };
    // The round is over: its media is deleted now and its URL stops working.
    const item = s.items.find((i) => i.id === round.itemID);
    if (item) this.dropItem(item);
    s.round = null;
    s.phase = 'results';
    s.phaseEndsAt = now + RESULTS_MS;
  }

  /** Host skips the rest of the results pause. */
  advance(id: string, now: number) {
    this.requireHost(id);
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

  private endGame(now: number) {
    const s = this.state;
    // Unused media from this game is deleted as soon as it ends.
    for (const item of [...s.items]) this.dropItem(item);
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
    s.phase = 'lobby';
    s.game += 1;
    s.lastResult = null;
    s.totalRounds = 0;
    s.shown = {};
    for (const p of s.players) Object.assign(p, { ready: false, score: 0, streak: 0, bestStreak: 0, correctMs: 0, correctCount: 0 });
    s.lastActivityAt = now;
  }

  close() {
    for (const item of [...this.state.items]) this.dropItem(item);
    this.state.round = null;
    this.state.phase = 'closed';
    this.state.phaseEndsAt = null;
  }

  // ---- time ----

  /** Applies every transition and cleanup that is due at `now`. */
  tick(now: number) {
    const s = this.state;
    for (let guard = 0; guard < 100 && s.phase !== 'closed'; guard++) {
      if (s.phaseEndsAt === null || now < s.phaseEndsAt) break;
      const at = s.phaseEndsAt;
      if (s.phase === 'countdown' && s.round) {
        s.round.revealAt = at;
        s.round.endsAt = at + s.settings.timerSeconds * 1000;
        s.phase = 'reveal';
        s.phaseEndsAt = s.round.endsAt;
        this.finishIfEveryoneGuessed(at);
      } else if (s.phase === 'reveal' && s.round) {
        this.finishRound(at);
      } else if (s.phase === 'results') {
        const next = (s.lastResult?.index ?? 0) + 1;
        if (next > s.totalRounds) this.endGame(at);
        else this.beginRound(next, at);
      } else s.phaseEndsAt = null;
    }
    if (s.phase === 'closed') return;
    for (const p of [...s.players]) if (!p.connected && p.disconnectedAt !== null && now >= p.disconnectedAt + DISCONNECT_GRACE_MS) this.leave(p.id, now);
    if ((s.phase as Phase) === 'closed') return;
    for (const item of s.items.filter((i) => now >= i.expiresAt && i.id !== s.round?.itemID)) this.dropItem(item);
    if (s.emptySince !== null && now >= s.emptySince + EMPTY_ROOM_GRACE_MS) return this.close();
    const idle = this.idleDeadline();
    if (idle !== null && now >= idle) this.close();
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
      s.emptySince === null ? null : s.emptySince + EMPTY_ROOM_GRACE_MS,
      this.idleDeadline(),
      ...s.players.map((p) => (p.connected || p.disconnectedAt === null ? null : p.disconnectedAt + DISCONNECT_GRACE_MS)),
      ...s.items.map((i) => i.expiresAt),
    ].filter((t): t is number => t !== null);
    return times.length ? Math.min(...times) : null;
  }

  // ---- views ----

  /** What one player is allowed to see. Never includes the owner before results, other players' guesses, or storage keys. */
  view(viewerID: string, now: number, mediaPath: (capability: string) => string) {
    const s = this.state;
    const round = s.round;
    const counts = (id: string, kind: MediaKind) => s.items.filter((i) => i.ownerID === id && i.kind === kind).length;
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
      startBlocker: s.phase === 'lobby' ? this.startBlocker() : null,
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
          photos: counts(p.id, 'photo'),
          videos: counts(p.id, 'video'),
        })),
      you: {
        id: viewerID,
        items: s.items.filter((i) => i.ownerID === viewerID).map((i) => ({ id: i.id, kind: i.kind, durationMs: i.durationMs ?? null })),
      },
      round:
        round && (s.phase === 'countdown' || s.phase === 'reveal')
          ? {
              index: round.index,
              total: s.totalRounds,
              ...(s.phase === 'reveal'
                ? {
                    kind: round.kind,
                    mediaPath: mediaPath(round.capability),
                    revealAt: round.revealAt,
                    endsAt: round.endsAt,
                    canGuess: round.guessers.includes(viewerID) && viewerID !== round.ownerID,
                    isYours: viewerID === round.ownerID,
                    yourGuess: round.guesses[viewerID]?.targetID ?? null,
                    guessedCount: Object.keys(round.guesses).length,
                    guesserCount: round.guessers.length,
                  }
                : {}),
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
