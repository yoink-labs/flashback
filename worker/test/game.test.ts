import { describe, expect, it } from 'vitest';
import {
  BREAK_SECONDS,
  CAPACITY,
  COUNTDOWN_MS,
  DISCONNECT_GRACE_MS,
  HOST_GRACE_MS,
  EMPTY_ROOM_GRACE_MS,
  FINISHED_ROOM_GRACE_MS,
  Game,
  GameError,
  GUESS_GRACE_MS,
  MEDIA_SETTLE_MS,
  newRoom,
  PAUSE_MAX_MS,
  SWAPS,
  UPLOAD_TIMEOUT_MS,
  type RoomState,
} from '../src/game';
import { PHOTO_BUNCH, VIDEO_BUNCH } from '../src/bunch';
import type { MediaKind } from '../src/media';
import { defaultSettings } from '../src/settings';
import { sequenceRandom } from './helpers';

const T0 = 1_000_000;

function lobby(names = ['Host', 'Bea', 'Cal']) {
  const game = new Game(newRoom('ABC234', 'inst', T0), sequenceRandom());
  const players = names.map((n) => game.join({ kind: 'guest' }, n, T0));
  for (const p of players) game.connect(p.id, T0);
  return { game, players, ids: players.map((p) => p.id) };
}

function giveDecks(game: Game, ids: string[], photos = PHOTO_BUNCH, videos = VIDEO_BUNCH) {
  for (const id of ids) game.setDeck(id, photos, videos, T0);
}

function readyAll(game: Game, ids: string[], photos = PHOTO_BUNCH, videos = VIDEO_BUNCH) {
  giveDecks(game, ids, photos, videos);
  for (const id of ids) game.setReady(id, true, T0);
}

/** A lobby with decks and everyone ready, but no game started. */
function core(names = ['Host', 'Bea', 'Cal']) {
  const setup = lobby(names);
  readyAll(setup.game, setup.ids);
  return setup;
}

const slotFor = (game: Game, round: number) => game.state.slots.find((slot) => slot.round === round)!;

function err(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return (e as GameError).message;
  }
  throw new Error('expected a GameError');
}

function errStatus(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return (e as GameError).status;
  }
  throw new Error('expected a GameError');
}

/** Starts a game and uploads the current round's item at `now`, then reveals it. */
function revealRound(game: Game, round: number, now: number, kind?: MediaKind) {
  const slot = slotFor(game, round);
  if (slot.status === 'requested') game.markReady(slot.ownerID, slot.id, kind ?? slot.requiredKind, now);
  game.tick(game.state.phaseEndsAt!);
  expect(game.state.phase).toBe('reveal');
  return game.state.round!;
}

describe('joining', () => {
  it('makes the first player host and rejects duplicate nicknames', () => {
    const { game, ids } = lobby(['Host']);
    expect(game.state.hostID).toBe(ids[0]);
    expect(err(() => game.join({ kind: 'guest' }, 'host', T0))).toMatch(/already in this room/);
    expect(err(() => game.join({ kind: 'guest' }, '   ', T0))).toMatch(/Choose a nickname/);
  });

  it('caps the room size', () => {
    const { game } = lobby(Array.from({ length: CAPACITY }, (_, i) => `P${i}`));
    expect(err(() => game.join({ kind: 'guest' }, 'One more', T0))).toMatch(/full \(12 players\)/);
  });

  it('lets a signed-in player and guests share a room, and returns the same seat on rejoin', () => {
    const { game } = lobby(['Guest']);
    const clerk = game.join({ kind: 'clerk', userID: 'user_1' }, 'Clerky', T0);
    expect(clerk.kind).toBe('clerk');
    expect(game.join({ kind: 'clerk', userID: 'user_1' }, 'Other name', T0).id).toBe(clerk.id);
    const view = game.view(clerk.id, T0);
    expect(view.players.map((p) => [p.nickname, p.signedIn])).toEqual([
      ['Guest', false],
      ['Clerky', true],
    ]);
    expect(JSON.stringify(view)).not.toContain('user_1');
  });

  it('blocks new players mid-game', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    expect(err(() => game.join({ kind: 'guest' }, 'Late', T0))).toMatch(/in progress/);
  });
});

describe('decks, ready, and start rules', () => {
  it('reports decks and requires the full bunch that fits the mode', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    expect(game.player(ids[0])!.deck).toEqual({ photos: 0, videos: 0 });
    const view = game.view(ids[0], T0);
    expect(view.you).toEqual({ id: ids[0] });
    expect(view.players.map((p) => p.deck)).toEqual([
      { photos: 0, videos: 0 },
      { photos: 0, videos: 0 },
    ]);
    expect('photos' in view.players[0]).toBe(false);

    expect(lobby(['Host']).game.startBlocker()).toBe('Waiting for players');
    expect(game.startBlocker()).toBe('Deal 12 photos and 6 videos');
    // The blocker is worded as the task for each viewer and "Waiting" for others.
    expect(game.view(ids[0], T0).startBlocker).toBe('Deal 12 photos and 6 videos');
    expect(game.view(ids[1], T0).startBlocker).toBe('Waiting for Host');

    // A partial bunch names just what is missing.
    game.setDeck(ids[0], 12, 4, T0);
    expect(game.startBlocker()).toBe('Add 2 more videos');
    expect(game.view(ids[1], T0).startBlocker).toBe('Waiting for Host');
    game.setDeck(ids[0], 12, 6, T0);
    game.setDeck(ids[1], 10, 0, T0);
    expect(game.view(ids[1], T0).startBlocker).toBe('Add 2 more photos and Deal 6 videos');
    expect(game.startBlocker()).toBe('Waiting for Bea');

    // The host never has to press Ready: Start is their ready.
    game.setDeck(ids[0], 12, 6, T0);
    game.setDeck(ids[1], 12, 6, T0);
    game.setReady(ids[1], true, T0);
    expect(game.startBlocker()).toBeNull();

    // Photos only: 12 photos; videos only: 6 videos.
    game.updateSettings(ids[0], { mediaMode: 'photos' }, T0);
    expect(game.startBlocker()).toBeNull();
    game.setDeck(ids[0], 11, 5, T0);
    expect(game.startBlocker()).toBe('Add 1 more photo');
    game.updateSettings(ids[0], { mediaMode: 'videos' }, T0);
    // Switching to videos keeps players whose decks still fit ready.
    expect(game.player(ids[0])!.ready).toBe(false);
    expect(game.player(ids[1])!.ready).toBe(true);
    expect(game.startBlocker()).toBe('Add 1 more video');
    game.setDeck(ids[0], 0, 4, T0);
    expect(err(() => game.setReady(ids[0], true, T0))).toBe('Add 2 more videos before you ready up.');
    game.setDeck(ids[0], 0, 0, T0);
    expect(err(() => game.setReady(ids[0], true, T0))).toBe('Deal 6 videos before you ready up.');
    game.setDeck(ids[0], 6, 6, T0);
    game.updateSettings(ids[0], { mediaMode: 'photos' }, T0);
    expect(game.startBlocker()).toBe('Add 6 more photos');
    game.setDeck(ids[0], 0, 6, T0);
    expect(err(() => game.setReady(ids[0], true, T0))).toBe('Deal 12 photos before you ready up.');
  });

  it('validates deck counts', () => {
    const { game, ids } = lobby(['Host']);
    expect(errStatus(() => game.setDeck(ids[0], 501, 0, T0))).toBe(422);
    expect(errStatus(() => game.setDeck(ids[0], 0, -1, T0))).toBe(422);
    expect(errStatus(() => game.setDeck(ids[0], 1.5, 0, T0))).toBe(422);
    expect(errStatus(() => game.setDeck(ids[0], '2', 0, T0))).toBe(422);
    for (const value of [NaN, Infinity, -Infinity, 1e9, null, true, undefined, {}]) {
      expect(errStatus(() => game.setDeck(ids[0], value, 0, T0)), String(value)).toBe(422);
    }
    game.setDeck(ids[0], 500, 500, T0);
    expect(game.player(ids[0])!.deck).toEqual({ photos: 500, videos: 500 });
  });

  it('rejects non-numeric settings of every kind', () => {
    const { game, ids } = lobby(['Host']);
    for (const key of ['rounds', 'timerSeconds', 'breakSeconds', 'swaps'] as const) {
      for (const value of [NaN, Infinity, -Infinity, 1e9, '5', null, true, {}]) {
        expect(errStatus(() => game.updateSettings(ids[0], { [key]: value }, T0)), `${key}=${String(value)}`).toBe(422);
      }
    }
    for (const mediaMode of ['movie', null, 3, {}]) {
      expect(errStatus(() => game.updateSettings(ids[0], { mediaMode }, T0)), String(mediaMode)).toBe(422);
    }
    expect(game.state.settings).toEqual(defaultSettings());
  });

  it('validates host settings and uses the defaults', () => {
    const { game, ids } = lobby();
    expect(game.state.settings).toEqual(defaultSettings());
    game.updateSettings(ids[0], { rounds: 3, timerSeconds: 15, mediaMode: 'videos', breakSeconds: 5, swaps: 1 }, T0);
    expect(game.state.settings).toEqual({ ...defaultSettings(), rounds: 3, timerSeconds: 15, mediaMode: 'videos', breakSeconds: 5, swaps: 1 });
    expect(err(() => game.updateSettings(ids[1], { rounds: 4 }, T0))).toMatch(/Only the host/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 0 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 101 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 2.5 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { timerSeconds: 5 }, T0))).toMatch(/timer must be/);
    expect(err(() => game.updateSettings(ids[0], { mediaMode: 'gifs' }, T0))).toMatch(/Photos, Videos, or Both/);
    expect(err(() => game.updateSettings(ids[0], { breakSeconds: 2 }, T0))).toMatch(/Break must be 3–30/);
    expect(err(() => game.updateSettings(ids[0], { breakSeconds: 31 }, T0))).toMatch(/Break must be/);
    expect(err(() => game.updateSettings(ids[0], { breakSeconds: 7.5 }, T0))).toMatch(/Break must be/);
    expect(errStatus(() => game.updateSettings(ids[0], { breakSeconds: 0 }, T0))).toBe(422);
    expect(err(() => game.updateSettings(ids[0], { swaps: -1 }, T0))).toMatch(/Swaps must be 0–10/);
    expect(err(() => game.updateSettings(ids[0], { swaps: 11 }, T0))).toMatch(/Swaps must be/);
    expect(err(() => game.updateSettings(ids[0], { swaps: 2.5 }, T0))).toMatch(/Swaps must be/);
    expect(errStatus(() => game.updateSettings(ids[0], { swaps: '3' }, T0))).toBe(422);
    game.updateSettings(ids[0], { rounds: 30, breakSeconds: 3, swaps: 0 }, T0);
    expect(game.state.settings).toEqual({ ...defaultSettings(), rounds: 30, timerSeconds: 15, mediaMode: 'videos', breakSeconds: 3, swaps: 0 });
    game.updateSettings(ids[0], { rounds: 100, breakSeconds: 30, swaps: 10 }, T0);
    expect(game.state.settings).toMatchObject({ rounds: 100, breakSeconds: 30, swaps: 10 });
  });

  it('normalizes old persisted rooms that predate breakSeconds, swaps, and pause', () => {
    const state = newRoom('ABC234', 'inst', T0) as unknown as Record<string, unknown>;
    delete (state.settings as Record<string, unknown>).breakSeconds;
    delete (state.settings as Record<string, unknown>).swaps;
    delete (state.settings as Record<string, unknown>).evenSplit;
    delete (state.settings as Record<string, unknown>).effects;
    delete (state.settings as Record<string, unknown>).powerups;
    delete state.pausedAt;
    delete state.pausedRemainingMs;
    delete state.roundKinds;
    delete state.schedule;
    delete state.shopBought;
    // An old open slot has no required kind either.
    (state.slots as Record<string, unknown>[]).push({ id: 's1', round: 1, ownerID: 'p1', status: 'requested', requestedAt: T0, attempts: 0, readyAt: null, tried: [] });
    const game = new Game(state as unknown as RoomState);
    expect(game.state.settings).toEqual(defaultSettings());
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.pausedRemainingMs).toBeNull();
    expect(game.state.settings.breakSeconds).toBe(BREAK_SECONDS.default);
    expect(game.state.settings.swaps).toBe(SWAPS.default);
    expect(game.state.roundKinds).toEqual([]);
    expect(game.state.slots[0].requiredKind).toBe('photo');
  });

  it('normalizes a room persisted by the previous milestone', () => {
    const state = newRoom('ABC234', 'inst', T0) as unknown as Record<string, unknown>;
    // M1 players had no deck counts; M2 rounds had no countdown start.
    (state.players as Record<string, unknown>[]).push({
      id: 'g_1',
      nickname: 'Old',
      kind: 'guest',
      joinSeq: 1,
      joinedAt: T0,
      connected: true,
      disconnectedAt: null,
      ready: false,
      score: 0,
      streak: 0,
      bestStreak: 0,
      correctMs: 0,
      correctCount: 0,
    });
    state.hostID = 'g_1';
    state.phase = 'countdown';
    state.round = { index: 1, slotID: 's1', ownerID: 'g_1', kind: null, revealAt: null, endsAt: null, guessers: [], guesses: {} };
    delete state.slots;
    delete state.owned;

    const game = new Game(state as unknown as RoomState);
    expect(game.state.slots).toEqual([]);
    expect(game.state.owned).toEqual({});
    expect(game.player('g_1')!.deck).toEqual({ photos: 0, videos: 0 });
    // Without a countdown start the round would produce NaN deadlines.
    expect(game.state.round!.countdownStart).toBe(T0);
    expect(game.view('g_1', T0).players[0].deck).toEqual({ photos: 0, videos: 0 });
  });

  it('only lets the host start, and only when everyone is ready with a fitting deck', () => {
    const { game, ids } = core(['Host', 'Bea']);
    expect(err(() => game.start(ids[1], T0))).toMatch(/Only the host/);
    game.start(ids[0], T0);
    expect(game.state.phase).toBe('countdown');
  });
});

describe('slots and turn-time uploads', () => {
  it('creates two slots with different owners and asks only those owners', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 2 }, T0);
    game.start(ids[0], T0);
    const [first, second] = game.state.slots;
    expect(game.state.slots.map((slot) => slot.round)).toEqual([1, 2]);
    expect(first.ownerID).not.toBe(second.ownerID);
    expect(first.status).toBe('requested');
    expect(first.attempts).toBe(0);
    expect(game.turnRequests).toHaveLength(2);
    expect(game.turnRequests.map((turn) => [turn.playerID, turn.round])).toEqual([
      [first.ownerID, 1],
      [second.ownerID, 2],
    ]);
    expect(game.turnRequests[0]).toMatchObject({ slot: first.id, game: 1, mode: 'both', kind: first.requiredKind });
    expect(first.requiredKind).toBe(game.state.roundKinds[0]);
    expect(second.requiredKind).toBe(game.state.roundKinds[1]);
    // Slot ids never reach a client.
    expect(JSON.stringify(game.view(ids[0], T0))).not.toContain(first.id);
  });

  it('waits for the round-1 upload, then gives clients time to receive it', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 2 }, T0);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.phaseEndsAt).toBeNull();
    expect(game.view(ids[0], T0).round).toMatchObject({ index: 1, total: 2, waiting: true, revealAt: null });

    // Ready quickly: the countdown still lasts its full three seconds.
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0 + 500);
    expect(game.state.phaseEndsAt).toBe(T0 + COUNTDOWN_MS);
    expect(game.view(ids[0], T0).round).toMatchObject({ index: 1, total: 2, waiting: false });

    // Ready late: clients get MEDIA_SETTLE_MS after the upload.
    const late = new Game(newRoom('ABC234', 'inst', T0), sequenceRandom());
    const [p1, p2] = ['Host', 'Bea'].map((name) => late.join({ kind: 'guest' }, name, T0));
    for (const p of [p1, p2]) late.connect(p.id, T0);
    giveDecks(late, [p1.id, p2.id]);
    for (const p of [p1, p2]) late.setReady(p.id, true, T0);
    late.start(p1.id, T0);
    const lateSlot = slotFor(late, 1);
    late.markReady(lateSlot.ownerID, lateSlot.id, lateSlot.requiredKind, T0 + 2_500);
    expect(late.state.phaseEndsAt).toBe(T0 + 2_500 + MEDIA_SETTLE_MS);
    late.tick(T0 + 2_500 + MEDIA_SETTLE_MS - 1);
    expect(late.state.phase).toBe('countdown');
    late.tick(T0 + 2_500 + MEDIA_SETTLE_MS);
    expect(late.state.phase).toBe('reveal');
  });

  it('rejects uploads from a non-owner, for a stale slot, or for an unknown slot', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    const other = ids.find((id) => id !== slot.ownerID)!;
    expect(errStatus(() => game.markReady(other, slot.id, slot.requiredKind, T0 + 1))).toBe(409);
    expect(errStatus(() => game.markReady(slot.ownerID, 'not-a-slot', slot.requiredKind, T0 + 1))).toBe(409);
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0 + 1);
    expect(errStatus(() => game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0 + 2))).toBe(409);
  });

  it('rejects an upload of the wrong kind and leaves the slot requested', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { mediaMode: 'photos' }, T0);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    expect(slot.requiredKind).toBe('photo');
    expect(err(() => game.markReady(slot.ownerID, slot.id, 'video', T0 + 1))).toBe('This round needs a photo.');
    expect(errStatus(() => game.markReady(slot.ownerID, slot.id, 'video', T0 + 2))).toBe(422);
    expect(slot.status).toBe('requested');
    expect(slot.kind).toBeUndefined();
    // The right kind still lands.
    game.markReady(slot.ownerID, slot.id, 'photo', T0 + 3);
    expect(slot.status).toBe('ready');
    expect(slot.kind).toBe('photo');
  });

  it('reassigns to a different owner on pass, and gives up when everyone has passed', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    const first = slot.ownerID;
    game.turnRequests.length = 0;

    game.pass(first, slot.id, T0 + 1_000);
    expect(slot.ownerID).not.toBe(first);
    expect(slot.attempts).toBe(1);
    const second = slot.ownerID;
    expect(game.turnRequests).toEqual([{ playerID: second, slot: slot.id, game: 1, round: 1, mode: 'both', kind: slot.requiredKind }]);

    // A late pass from the previous owner is ignored quietly (no error, no change).
    game.pass(first, slot.id, T0 + 1_500);
    expect(slot.ownerID).toBe(second);
    expect(slot.attempts).toBe(1);

    game.pass(second, slot.id, T0 + 2_000);
    const third = slot.ownerID;
    expect([first, second]).not.toContain(third);
    expect(slot.attempts).toBe(2);

    // Everyone eligible has now been asked: there is no item for this round.
    game.pass(third, slot.id, T0 + 3_000);
    expect(game.state.phase).toBe('podium');
    expect(game.state.slots).toHaveLength(0);
    expect(game.freedSlots).toContain(slot.id);
  });

  it('keeps asking players whose bunch has shrunk since the lobby', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 5, mediaMode: 'photos' }, T0);
    game.start(ids[0], T0);
    // Late in the game the pool is down to one photo each: a player can still
    // supply a photo round, even though their bunch is below the start size.
    game.setDeck(ids[0], 1, 0, T0 + 1);
    game.setDeck(ids[1], 1, 0, T0 + 1);
    const slot = slotFor(game, 1);
    const first = slot.ownerID;
    game.pass(first, slot.id, T0 + 2_000);
    expect(slot.ownerID).not.toBe(first);
    expect(game.state.phase).toBe('countdown');
  });

  it('reassigns when the upload times out', () => {
    const { game } = core();
    game.start(game.state.hostID!, T0);
    const first = slotFor(game, 1).ownerID;

    game.tick(T0 + UPLOAD_TIMEOUT_MS - 1);
    expect(slotFor(game, 1).ownerID).toBe(first);
    // A timeout re-picks for every requested slot at once.
    game.tick(T0 + UPLOAD_TIMEOUT_MS);
    expect(slotFor(game, 1).ownerID).not.toBe(first);
    expect(slotFor(game, 1).requestedAt).toBe(T0 + UPLOAD_TIMEOUT_MS);
    expect(game.turnRequests.length).toBeGreaterThanOrEqual(2);
  });

  it('reassigns when the owner disconnects', () => {
    const { game } = core();
    game.start(game.state.hostID!, T0);
    const first = slotFor(game, 1).ownerID;
    game.disconnect(first, T0 + 1_000);
    expect(slotFor(game, 1).ownerID).not.toBe(first);
    expect(game.state.phase).toBe('countdown');
  });

  it('reassigns when the owner leaves', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const first = slotFor(game, 1).ownerID;
    game.leave(first, T0 + 1_000);
    expect(game.removed).toContain(first);
    expect(slotFor(game, 1).ownerID).not.toBe(first);
    expect(game.state.phase).toBe('countdown');
  });

  it('keeps one round of lookahead: the next slot opens as the reveal begins', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 3 }, T0);
    game.start(ids[0], T0);
    expect(game.state.slots.map((slot) => slot.round)).toEqual([1, 2]);

    revealRound(game, 1, T0);
    expect(game.state.slots.map((slot) => slot.round).sort()).toEqual([1, 2]);
    // Round 1's slot stays in the state while its reveal is on screen.
    const round1 = game.state.round!;
    expect(game.state.slots.some((slot) => slot.id === round1.slotID)).toBe(true);

    // Finish round 1: its bytes are freed, and round 3 is requested as round 2 reveals.
    game.tick(game.state.phaseEndsAt!);
    expect(game.state.phase).toBe('results');
    expect(game.freedSlots).toContain(round1.slotID);
    expect(game.state.slots.some((slot) => slot.id === round1.slotID)).toBe(false);
    game.tick(game.state.phaseEndsAt!);
    expect(game.state.phase).toBe('countdown');
    revealRound(game, 2, game.state.round!.countdownStart);
    expect(game.state.slots.map((slot) => slot.round).sort()).toEqual([2, 3]);
  });
});

describe('balanced round kinds', () => {
  const counts = (game: Game) => ({
    photos: game.state.roundKinds.filter((kind) => kind === 'photo').length,
    videos: game.state.roundKinds.filter((kind) => kind === 'video').length,
  });

  it('balances a 10-round Mix game to 7 photos and 3 videos', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    expect(game.state.roundKinds).toHaveLength(10);
    expect(counts(game)).toEqual({ photos: 7, videos: 3 });
    // Each slot carries its round's kind, and so does the owner's turn request.
    for (const slot of game.state.slots) expect(slot.requiredKind).toBe(game.state.roundKinds[slot.round - 1]);
    expect(game.turnRequests.map((turn) => turn.kind)).toEqual([game.state.roundKinds[0], game.state.roundKinds[1]]);
  });

  it('rounds the photo share for short and long games', () => {
    const one = core();
    one.game.updateSettings(one.ids[0], { rounds: 1 }, T0);
    one.game.start(one.ids[0], T0);
    expect(counts(one.game)).toEqual({ photos: 1, videos: 0 });

    const thirty = core();
    thirty.game.updateSettings(thirty.ids[0], { rounds: 30 }, T0);
    thirty.game.start(thirty.ids[0], T0);
    expect(counts(thirty.game)).toEqual({ photos: 20, videos: 10 });
  });

  it('uses one kind for photos-only and videos-only games', () => {
    const photos = core();
    photos.game.updateSettings(photos.ids[0], { mediaMode: 'photos' }, T0);
    photos.game.start(photos.ids[0], T0);
    expect(counts(photos.game)).toEqual({ photos: 10, videos: 0 });

    const videos = core();
    videos.game.updateSettings(videos.ids[0], { mediaMode: 'videos' }, T0);
    videos.game.start(videos.ids[0], T0);
    expect(counts(videos.game)).toEqual({ photos: 0, videos: 10 });
  });

  it('does not tell non-owners which kind an open round needs', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const view = game.view(ids[1], T0);
    expect(view.round).toMatchObject({ index: 1, total: 10, waiting: true });
    expect(JSON.stringify(view)).not.toMatch(/requiredKind|"kind"/);
  });

  it('keeps a round’s kind when its slot changes hands', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    const kind = slot.requiredKind;
    const kinds = [...game.state.roundKinds];
    game.pass(slot.ownerID, slot.id, T0 + 1);
    expect(slot.requiredKind).toBe(kind);
    expect(game.state.roundKinds).toEqual(kinds);
  });
});

describe('reveal, guesses, and scoring', () => {
  it('shows the owner and everyone else exactly the same reveal', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 2, mediaMode: 'photos' }, T0);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    const owner = round.ownerID;
    const other = ids.find((id) => id !== owner)!;
    const ownerView = game.view(owner, T0 + COUNTDOWN_MS);
    const otherView = game.view(other, T0 + COUNTDOWN_MS);

    expect({ ...ownerView, you: null }).toEqual({ ...otherView, you: null });
    expect(ownerView.round).toMatchObject({ index: 1, total: 2, kind: 'photo', canGuess: true, yourGuess: null, guessedCount: 0, guesserCount: 3 });
    expect(JSON.stringify(ownerView)).not.toMatch(/ownerID|isYours|mediaPath|"slot"/);
  });

  it('lets the owner guess, including themselves, as a decoy that scores nothing and keeps their streak', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 2, timerSeconds: 20 }, T0);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    const revealAt = round.revealAt!;
    const owner = round.ownerID;
    const [g1, g2] = ids.filter((id) => id !== owner);

    expect(errStatus(() => game.guess(owner, 'nobody', revealAt + 1))).toBe(422);
    game.player(owner)!.streak = 2;
    game.guess(owner, owner, revealAt); // self-guess is allowed and correct
    game.guess(g1, owner, revealAt + 5_000);
    expect(game.view(g2, revealAt).round).toMatchObject({ guessedCount: 2, guesserCount: 3 });
    game.guess(g2, g1, revealAt + 6_000); // the last guess ends the round

    expect(game.state.phase).toBe('results');
    expect(game.state.lastResult!.ownerID).toBe(owner);
    const rows = Object.fromEntries(game.state.lastResult!.rows.map((row) => [row.playerID, row]));
    expect(rows[owner]).toMatchObject({ correct: true, points: 0, targetID: owner, streak: 2 });
    expect(rows[g1]).toMatchObject({ correct: true, points: 875 });
    expect(rows[g2]).toMatchObject({ correct: false, points: 0 });
    expect(game.player(owner)!.score).toBe(0);
    expect(game.player(owner)!.streak).toBe(2);
  });

  it('gives everyone connected when the reveal starts a guess, including the owner', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0);
    game.disconnect(ids[2], T0 + 1); // not present at the reveal
    game.tick(T0 + COUNTDOWN_MS);
    expect(game.state.phase).toBe('reveal');
    const round = game.state.round!;
    expect(round.guessers.sort()).toEqual([ids[0], ids[1]].sort());
    expect(round.guessers).toContain(round.ownerID);
  });

  it('rejects guesses from players who joined after the reveal and after time is up', () => {
    const { game, ids } = core(['Host', 'Bea', 'Cal']);
    game.start(ids[0], T0);
    // Not present when the reveal begins, so not a guesser for this round.
    game.disconnect(ids[2], T0 + 1);
    const round = revealRound(game, 1, T0);
    game.connect(ids[2], round.revealAt! + 1);
    expect(err(() => game.guess(ids[2], ids[0], round.revealAt! + 2))).toMatch(/joined after this round started/);
    expect(err(() => game.guess(ids[0], ids[1], round.endsAt! + 1))).toMatch(/Time is up/);
  });

  it('scores missing guesses as zero when the timer runs out', () => {
    const { game } = core(['Host', 'Bea']);
    game.updateSettings(game.state.players[0].id, { rounds: 1 }, T0);
    game.start(game.state.players[0].id, T0);
    const round = revealRound(game, 1, T0);
    game.tick(round.endsAt! + GUESS_GRACE_MS - 1);
    expect(game.state.phase).toBe('reveal');
    game.tick(round.endsAt! + GUESS_GRACE_MS);
    expect(game.state.phase).toBe('results');
    expect(game.state.lastResult!.rows.every((row) => row.points === 0 && row.targetID === null)).toBe(true);
  });
});

describe('rounds and game end', () => {
  it('honours the configured round count and ends on the podium', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 3, timerSeconds: 10 }, T0);
    game.start(ids[0], T0);
    expect(game.state.totalRounds).toBe(3);

    let now = T0;
    for (let round = 1; round <= 3; round++) {
      revealRound(game, round, now);
      game.tick(game.state.phaseEndsAt!); // timer runs out
      expect(game.state.phase).toBe('results');
      now = game.state.phaseEndsAt!;
      game.tick(now); // next countdown, or the podium after round 3
    }
    expect(game.state.phase).toBe('podium');
    expect(game.state.lastResult!.index).toBe(3);
    expect(game.state.slots).toHaveLength(0);
  });

  it('spreads rounds evenly across owners and avoids the same owner twice in a row', () => {
    const { game, ids } = core(['Host', 'Bea', 'Cal']);
    game.updateSettings(ids[0], { rounds: 9, timerSeconds: 10 }, T0);
    game.start(ids[0], T0);
    const owners: string[] = [];
    let now = T0;
    for (let round = 1; round <= 9; round++) {
      owners.push(slotFor(game, round).ownerID);
      revealRound(game, round, now);
      game.tick(game.state.phaseEndsAt!);
      now = game.state.phaseEndsAt!;
      game.tick(now);
    }
    expect(game.state.phase).toBe('podium');
    for (const id of ids) expect(owners.filter((o) => o === id)).toHaveLength(3);
    for (let i = 1; i < owners.length; i++) expect(owners[i]).not.toBe(owners[i - 1]);
  });

  it('starts the reveal when the tick runs, not when the countdown was due', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 3, timerSeconds: 20 }, T0);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0);

    // The alarm can run late (hibernation, deploy). The round must still get its
    // full reveal instead of being skipped to results.
    const late = T0 + COUNTDOWN_MS + 60_000;
    game.tick(late);
    expect(game.state.phase).toBe('reveal');
    expect(game.state.round!.revealAt).toBe(late);
    expect(game.state.round!.endsAt).toBe(late + 20_000);
    expect(game.state.phaseEndsAt).toBe(late + 20_000 + GUESS_GRACE_MS);
  });

  it('gives the next round a full countdown when the results deadline ran late', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 3 }, T0);
    game.start(ids[0], T0);
    revealRound(game, 1, T0);
    // Upload round 2's item during round 1's reveal (the lookahead turn).
    const next = slotFor(game, 2);
    game.markReady(next.ownerID, next.id, next.requiredKind, T0 + COUNTDOWN_MS);
    game.tick(game.state.phaseEndsAt!);
    expect(game.state.phase).toBe('results');

    const late = game.state.phaseEndsAt! + 120_000;
    game.tick(late);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.round!.index).toBe(2);
    expect(game.state.round!.countdownStart).toBe(late);
    expect(game.state.phaseEndsAt).toBe(late + COUNTDOWN_MS);
  });

  it('uses breakSeconds as the results length', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 2, breakSeconds: 4 }, T0);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    game.tick(round.endsAt! + GUESS_GRACE_MS);
    expect(game.state.phase).toBe('results');
    expect(game.state.phaseEndsAt).toBe(round.endsAt! + GUESS_GRACE_MS + 4_000);
  });

  it('lets the host skip results, end early, and play again in the same room', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 3 }, T0);
    game.start(ids[0], T0);
    revealRound(game, 1, T0);
    game.tick(game.state.phaseEndsAt!);
    expect(game.state.phase).toBe('results');
    expect(err(() => game.advance(ids[1], T0 + 40_000))).toMatch(/Only the host/);
    game.advance(ids[0], T0 + 40_000);
    expect(game.state.phase).toBe('countdown');
    game.end(ids[0], T0 + 41_000);
    expect(game.state.phase).toBe('podium');
    expect(game.state.slots).toHaveLength(0);
    expect(err(() => game.playAgain(ids[1], T0 + 42_000))).toMatch(/Only the host/);
    game.playAgain(ids[0], T0 + 42_000);
    expect(game.state.phase).toBe('lobby');
    expect(game.state.game).toBe(2);
    expect(game.state.players.every((p) => p.score === 0 && !p.ready)).toBe(true);
    expect(game.state.players.map((p) => p.deck)).toEqual([
      { photos: PHOTO_BUNCH, videos: VIDEO_BUNCH },
      { photos: PHOTO_BUNCH, videos: VIDEO_BUNCH },
      { photos: PHOTO_BUNCH, videos: VIDEO_BUNCH },
    ]);
  });
});

describe('pause and resume', () => {
  it('only lets the host pause, and only while a game is running', () => {
    const { game, ids } = core();
    expect(errStatus(() => game.pause(ids[0], T0))).toBe(409);
    expect(errStatus(() => game.resume(ids[0], T0))).toBe(409);
    expect(game.view(ids[0], T0)).toMatchObject({ paused: false, pausedRemainingMs: null });

    game.start(ids[0], T0);
    expect(errStatus(() => game.pause(ids[1], T0 + 1))).toBe(403);
    game.pause(ids[0], T0 + 1);
    expect(errStatus(() => game.pause(ids[0], T0 + 2))).toBe(409);
    expect(errStatus(() => game.resume(ids[1], T0 + 2))).toBe(403);
  });

  it('pauses a countdown that is still waiting, accepts the upload, and counts down on resume', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    expect(game.state.phaseEndsAt).toBeNull();

    game.pause(ids[0], T0 + 1_000);
    expect(game.state.pausedAt).toBe(T0 + 1_000);
    expect(game.state.pausedRemainingMs).toBeNull();
    expect(game.view(ids[1], T0 + 1_000)).toMatchObject({ phase: 'countdown', phaseEndsAt: null, paused: true, pausedRemainingMs: null });
    expect(game.view(ids[1], T0 + 1_000).round).toMatchObject({ index: 1, total: 10, waiting: true });
    expect(err(() => game.guess(ids[1], ids[0], T0 + 1_100))).toBe('The game is paused.');

    // The upload still lands while paused, but the clock does not start.
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0 + 2_000);
    expect(slot.status).toBe('ready');
    expect(game.state.phaseEndsAt).toBeNull();
    game.tick(T0 + 90_000);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.phaseEndsAt).toBeNull();

    game.resume(ids[0], T0 + 100_000);
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.pausedRemainingMs).toBeNull();
    expect(game.state.phaseEndsAt).toBe(T0 + 100_000 + COUNTDOWN_MS);
    expect(game.view(ids[0], T0 + 100_000).round).toMatchObject({ index: 1, total: 10, waiting: false });
    game.tick(T0 + 100_000 + COUNTDOWN_MS);
    expect(game.state.phase).toBe('reveal');
  });

  it('pauses a ready countdown and resumes with the time that was left', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0);
    expect(game.state.phaseEndsAt).toBe(T0 + COUNTDOWN_MS);

    game.pause(ids[0], T0 + 1_000);
    expect(game.state.phaseEndsAt).toBeNull();
    expect(game.state.pausedRemainingMs).toBe(COUNTDOWN_MS - 1_000);
    expect(game.view(ids[1], T0 + 1_000)).toMatchObject({ paused: true, pausedRemainingMs: 2_000 });
    // The upload is in: a paused countdown is frozen, not "Shuffling…".
    expect(game.view(ids[1], T0 + 1_000).round).toMatchObject({ index: 1, total: 10, waiting: false });

    // Time passing while paused changes nothing.
    game.tick(T0 + 60_000);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.phaseEndsAt).toBeNull();

    game.resume(ids[0], T0 + 60_000);
    expect(game.state.phaseEndsAt).toBe(T0 + 62_000);
    game.tick(T0 + 61_999);
    expect(game.state.phase).toBe('countdown');
    game.tick(T0 + 62_000);
    expect(game.state.phase).toBe('reveal');
  });

  it('pauses a reveal: no guesses, no advance, timers shift, and speed ignores the pause', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 2, timerSeconds: 20 }, T0);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    const revealAt = round.revealAt!;
    const endsAt = round.endsAt!;
    const [a, b, c] = ids;

    // A guess before the pause keeps its own elapsed time.
    game.guess(a, round.ownerID, revealAt + 500);

    game.pause(ids[0], revealAt + 1_000);
    expect(game.state.pausedRemainingMs).toBe(endsAt - (revealAt + 1_000));
    expect(err(() => game.guess(b, a, revealAt + 2_000))).toBe('The game is paused.');
    expect(errStatus(() => game.advance(ids[0], revealAt + 2_000))).toBe(409);

    // Even long past the old deadline, tick cannot finish the round.
    game.tick(endsAt + 60_000);
    expect(game.state.phase).toBe('reveal');
    expect(game.state.pausedAt).toBe(revealAt + 1_000);

    const resumeAt = revealAt + 90_000;
    game.resume(ids[0], resumeAt);
    const shift = resumeAt - (revealAt + 1_000);
    expect(round.revealAt).toBe(revealAt + shift);
    expect(round.endsAt).toBe(endsAt + shift);
    expect(game.state.phaseEndsAt).toBe(round.endsAt! + GUESS_GRACE_MS);

    // 2s and 3s after the shifted reveal, not 92s and 93s.
    game.guess(b, a, resumeAt + 1_000);
    game.guess(c, a, resumeAt + 2_000);
    expect(game.state.phase).toBe('results');
    const rows = Object.fromEntries(game.state.lastResult!.rows.map((row) => [row.playerID, row]));
    expect(rows[a].elapsedMs).toBe(500);
    expect(rows[b].elapsedMs).toBe(2_000);
    expect(rows[c].elapsedMs).toBe(3_000);
  });

  it('does not finish a reveal while paused, and finishes on resume once everyone here has guessed', () => {
    const { game, ids } = core(['Host', 'Bea', 'Cal']);
    game.updateSettings(ids[0], { rounds: 2 }, T0);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    const revealAt = round.revealAt!;

    game.guess(ids[0], round.ownerID, revealAt + 100);
    game.guess(ids[1], round.ownerID, revealAt + 200);
    game.pause(ids[0], revealAt + 300);
    // The third player drops while paused: everyone still here has guessed, but
    // a round must not finish while paused.
    game.disconnect(ids[2], revealAt + 400);
    expect(game.state.phase).toBe('reveal');
    expect(game.state.pausedAt).toBe(revealAt + 300);

    game.resume(ids[0], revealAt + 10_000);
    expect(game.state.phase).toBe('results');
  });

  it('stops waiting for a countdown upload that lands during a pause', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    game.pause(ids[0], T0 + 1_000);
    expect(game.view(ids[1], T0 + 1_000).round).toMatchObject({ index: 1, total: 10, waiting: true });

    // The media arrived while paused: the countdown is frozen, not waiting.
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0 + 2_000);
    expect(game.view(ids[1], T0 + 3_000).round).toMatchObject({ index: 1, total: 10, waiting: false });
    expect(game.state.phaseEndsAt).toBeNull();
  });

  it('finishes a reveal that ran out of time exactly when it was paused', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    const endsAt = round.endsAt!;

    game.pause(ids[0], endsAt);
    expect(game.state.pausedRemainingMs).toBe(0);
    game.tick(endsAt + 60_000);
    expect(game.state.phase).toBe('reveal');

    game.resume(ids[0], endsAt + 60_000);
    game.tick(endsAt + 60_000);
    // Paused with no time left: on resume only the in-flight guess grace remains.
    expect(game.state.phase).toBe('reveal');
    game.tick(endsAt + 60_000 + GUESS_GRACE_MS);
    expect(game.state.phase).toBe('results');
    expect(game.state.lastResult!.index).toBe(1);
  });

  it('re-picks a timed-out upload while paused without starting the clock', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    const first = slot.ownerID;
    game.pause(ids[0], T0 + 1_000);

    const timeout = T0 + 1_000 + UPLOAD_TIMEOUT_MS;
    game.tick(timeout);
    expect(slot.ownerID).not.toBe(first);
    expect(slot.requestedAt).toBe(timeout);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.pausedAt).toBe(T0 + 1_000);
    expect(game.state.phaseEndsAt).toBeNull();
  });

  it('measures a guess made the instant a reveal resumes from the frozen elapsed time', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    game.pause(ids[0], round.revealAt! + 500);

    const resumeAt = round.revealAt! + 90_000;
    game.resume(ids[0], resumeAt);
    for (const id of ids) game.guess(id, round.ownerID, resumeAt);
    expect(game.state.phase).toBe('results');
    // 500 ms into the reveal, not 90 seconds: the pause is not counted.
    expect(game.state.lastResult!.rows.every((row) => row.elapsedMs === 500)).toBe(true);
  });

  it('pauses results and resumes the remaining break', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 3, breakSeconds: 5 }, T0);
    game.start(ids[0], T0);
    const round = revealRound(game, 1, T0);
    const resultsAt = round.endsAt! + GUESS_GRACE_MS;
    game.tick(resultsAt);
    expect(game.state.phase).toBe('results');
    expect(game.state.phaseEndsAt).toBe(resultsAt + 5_000);

    game.pause(ids[0], resultsAt + 2_000);
    expect(game.state.pausedRemainingMs).toBe(3_000);
    expect(errStatus(() => game.advance(ids[0], resultsAt + 3_000))).toBe(409);
    game.tick(resultsAt + 60_000);
    expect(game.state.phase).toBe('results');

    game.resume(ids[0], resultsAt + 70_000);
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.phaseEndsAt).toBe(resultsAt + 73_000);
    game.tick(resultsAt + 73_000);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.round!.index).toBe(2);
  });

  it('ends the game when a leave drops the room below two players while paused', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    game.pause(ids[0], T0 + 500);
    game.leave(ids[1], T0 + 1_000);
    expect(game.state.phase).toBe('podium');
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.pausedRemainingMs).toBeNull();
    expect(game.view(ids[0], T0 + 1_000)).toMatchObject({ paused: false, pausedRemainingMs: null });
  });

  it('follows the host through a pause so the new host can resume', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0);
    game.pause(ids[0], T0 + 1_000);
    expect(errStatus(() => game.pause(ids[1], T0 + 1_100))).toBe(403);

    game.disconnect(ids[0], T0 + 2_000);
    expect(game.state.hostID).toBe(ids[0]);
    const moved = T0 + 2_000 + HOST_GRACE_MS;
    game.tick(moved);
    expect(game.state.hostID).toBe(ids[1]);
    expect(game.state.pausedAt).toBe(T0 + 1_000);
    expect(errStatus(() => game.resume(ids[0], moved))).toBe(403);

    game.resume(ids[1], moved);
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.phaseEndsAt).toBe(moved + (COUNTDOWN_MS - 1_000));
    expect(game.view(ids[1], moved)).toMatchObject({ paused: false, pausedRemainingMs: null });
  });

  it('auto-resumes ten minutes after the pause began', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    const first = slotFor(game, 1);
    game.markReady(first.ownerID, first.id, first.requiredKind, T0);
    const second = slotFor(game, 2);
    game.markReady(second.ownerID, second.id, second.requiredKind, T0);
    expect(game.state.phaseEndsAt).toBe(T0 + COUNTDOWN_MS);

    game.pause(ids[0], T0 + 1_000);
    expect(game.state.pausedRemainingMs).toBe(2_000);
    expect(game.nextDeadline()).toBe(T0 + 1_000 + PAUSE_MAX_MS);

    game.tick(T0 + 1_000 + PAUSE_MAX_MS - 1);
    expect(game.state.pausedAt).toBe(T0 + 1_000);
    game.tick(T0 + 1_000 + PAUSE_MAX_MS);
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.pausedRemainingMs).toBeNull();
    expect(game.state.phaseEndsAt).toBe(T0 + 1_000 + PAUSE_MAX_MS + 2_000);
    expect(game.view(ids[0], T0 + 1_000 + PAUSE_MAX_MS)).toMatchObject({ paused: false, pausedRemainingMs: null });
  });

  it('closes an empty paused room and clears the pause', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    game.pause(ids[0], T0 + 500);
    game.disconnect(ids[0], T0 + 1_000);
    game.disconnect(ids[1], T0 + 1_000);
    game.tick(T0 + 1_000 + EMPTY_ROOM_GRACE_MS);
    expect(game.state.phase).toBe('closed');
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.pausedRemainingMs).toBeNull();
  });

  it('lets the host end the game while paused, clearing the pause', () => {
    const { game, ids } = core();
    game.start(ids[0], T0);
    game.pause(ids[0], T0 + 1_000);
    game.end(ids[0], T0 + 2_000);
    expect(game.state.phase).toBe('podium');
    expect(game.state.pausedAt).toBeNull();
    expect(game.state.pausedRemainingMs).toBeNull();
    expect(game.state.phaseEndsAt).toBeNull();

    game.playAgain(ids[0], T0 + 3_000);
    expect(game.state.phase).toBe('lobby');
    expect(game.view(ids[0], T0 + 3_000)).toMatchObject({ paused: false, pausedRemainingMs: null });
  });
});

describe('hosts, leaving, and cleanup', () => {
  it('keeps a dropped host for HOST_GRACE_MS, then transfers to the longest-present connected player', () => {
    const { game, ids } = lobby(['Host', 'Bea', 'Cal']);
    game.disconnect(ids[1], T0);
    game.disconnect(ids[0], T0);
    expect(game.state.hostID).toBe(ids[0]);
    expect(game.nextDeadline()).toBe(T0 + HOST_GRACE_MS);
    game.tick(T0 + HOST_GRACE_MS - 1);
    expect(game.state.hostID).toBe(ids[0]);
    game.tick(T0 + HOST_GRACE_MS);
    expect(game.state.hostID).toBe(ids[2]);
    const t1 = T0 + HOST_GRACE_MS;
    game.connect(ids[1], t1);
    game.disconnect(ids[2], t1);
    game.tick(t1 + HOST_GRACE_MS);
    expect(game.state.hostID).toBe(ids[1]);
  });

  it('a host who comes back within the grace period stays host', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    game.disconnect(ids[0], T0);
    game.tick(T0 + 5_000);
    game.connect(ids[0], T0 + 5_000);
    game.tick(T0 + HOST_GRACE_MS + 1);
    expect(game.state.hostID).toBe(ids[0]);
  });

  it('ends a running game when fewer than two players remain and frees every slot', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    const slotIDs = game.state.slots.map((slot) => slot.id);
    expect(slotIDs).toHaveLength(2);
    game.leave(ids[1], T0 + 1);
    expect(game.state.phase).toBe('podium');
    expect(game.state.slots).toHaveLength(0);
    expect([...game.freedSlots].sort()).toEqual([...slotIDs].sort());
    expect(game.removed).toEqual([ids[1]]);
  });

  it('removes players after the reconnect grace period and closes empty rooms', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.disconnect(ids[1], T0);
    expect(game.nextDeadline()).toBe(T0 + DISCONNECT_GRACE_MS);
    game.tick(T0 + DISCONNECT_GRACE_MS);
    expect(game.player(ids[1])).toBeUndefined();
    game.disconnect(ids[0], T0 + DISCONNECT_GRACE_MS);
    game.tick(T0 + DISCONNECT_GRACE_MS + EMPTY_ROOM_GRACE_MS);
    expect(game.state.phase).toBe('closed');
    expect(game.state.slots).toHaveLength(0);
  });

  it('closes rooms when the last player leaves', () => {
    const { game, ids } = lobby(['Host']);
    game.leave(ids[0], T0);
    expect(game.state.phase).toBe('closed');
  });

  it('closes finished rooms after a grace period', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.start(ids[0], T0);
    game.end(ids[0], T0);
    expect(game.nextDeadline()).toBe(T0 + FINISHED_ROOM_GRACE_MS);
    game.tick(T0 + FINISHED_ROOM_GRACE_MS);
    expect(game.state.phase).toBe('closed');
  });

  it('closes idle lobbies', () => {
    const { game } = lobby(['Host', 'Bea']);
    game.tick(T0 + 60 * 60_000);
    expect(game.state.phase).toBe('closed');
  });
});
