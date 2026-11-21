import { describe, expect, it } from 'vitest';
import {
  CAPACITY,
  COUNTDOWN_MS,
  DISCONNECT_GRACE_MS,
  EMPTY_ROOM_GRACE_MS,
  FINISHED_ROOM_GRACE_MS,
  Game,
  GameError,
  MEDIA_SETTLE_MS,
  newRoom,
  ROUNDS,
  UPLOAD_TIMEOUT_MS,
} from '../src/game';
import type { MediaKind } from '../src/media';
import { sequenceRandom } from './helpers';

const T0 = 1_000_000;

function lobby(names = ['Host', 'Bea', 'Cal']) {
  const game = new Game(newRoom('ABC234', 'inst', T0), sequenceRandom());
  const players = names.map((n) => game.join({ kind: 'guest' }, n, T0));
  for (const p of players) game.connect(p.id, T0);
  return { game, players, ids: players.map((p) => p.id) };
}

function giveDecks(game: Game, ids: string[], photos = 2, videos = 0) {
  for (const id of ids) game.setDeck(id, photos, videos, T0);
}

function readyAll(game: Game, ids: string[], photos = 2, videos = 0) {
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
function revealRound(game: Game, round: number, now: number, kind: MediaKind = 'photo') {
  const slot = slotFor(game, round);
  if (slot.status === 'requested') game.markReady(slot.ownerID, slot.id, kind, now);
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
  it('reports decks and requires one item that fits the mode', () => {
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
    expect(game.startBlocker()).toBe('Add a photo or video to your deck');
    game.setDeck(ids[0], 2, 0, T0);
    expect(game.startBlocker()).toBe('Waiting for Bea');
    // Worded for each viewer.
    expect(game.view(ids[1], T0).startBlocker).toBe('Add a photo or video to your deck');
    expect(game.view(ids[0], T0).startBlocker).toBe('Waiting for Bea');
    game.setDeck(ids[1], 0, 1, T0);
    expect(game.startBlocker()).toBe('Waiting for Bea');
    // The host never has to press Ready: Start is their ready.
    game.setReady(ids[1], true, T0);
    expect(game.startBlocker()).toBeNull();

    // Switching to videos un-readies the player whose deck no longer fits.
    game.updateSettings(ids[0], { mediaMode: 'videos' }, T0);
    expect(game.player(ids[0])!.ready).toBe(false);
    expect(game.player(ids[1])!.ready).toBe(true);
    expect(game.startBlocker()).toBe('Add a video to your deck');
    game.setDeck(ids[0], 0, 0, T0);
    expect(err(() => game.setReady(ids[0], true, T0))).toMatch(/Add a video before you ready up/);
  });

  it('validates deck counts', () => {
    const { game, ids } = lobby(['Host']);
    expect(errStatus(() => game.setDeck(ids[0], 501, 0, T0))).toBe(422);
    expect(errStatus(() => game.setDeck(ids[0], 0, -1, T0))).toBe(422);
    expect(errStatus(() => game.setDeck(ids[0], 1.5, 0, T0))).toBe(422);
    expect(errStatus(() => game.setDeck(ids[0], '2', 0, T0))).toBe(422);
    game.setDeck(ids[0], 500, 500, T0);
    expect(game.player(ids[0])!.deck).toEqual({ photos: 500, videos: 500 });
  });

  it('validates host settings and uses the M2 defaults', () => {
    const { game, ids } = lobby();
    expect(game.state.settings).toEqual({ rounds: ROUNDS.default, timerSeconds: 20, mediaMode: 'both' });
    game.updateSettings(ids[0], { rounds: 3, timerSeconds: 15, mediaMode: 'videos' }, T0);
    expect(game.state.settings).toEqual({ rounds: 3, timerSeconds: 15, mediaMode: 'videos' });
    expect(err(() => game.updateSettings(ids[1], { rounds: 4 }, T0))).toMatch(/Only the host/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 0 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 31 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 2.5 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { timerSeconds: 5 }, T0))).toMatch(/timer must be/);
    expect(err(() => game.updateSettings(ids[0], { mediaMode: 'gifs' }, T0))).toMatch(/Photos, Videos, or Both/);
    game.updateSettings(ids[0], { rounds: 30 }, T0);
    expect(game.state.settings.rounds).toBe(30);
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
    expect(game.turnRequests[0]).toMatchObject({ slot: first.id, game: 1, mode: 'both' });
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
    expect(game.view(ids[0], T0).round).toEqual({ index: 1, total: 2, waiting: true });

    // Ready quickly: the countdown still lasts its full three seconds.
    game.markReady(slot.ownerID, slot.id, 'photo', T0 + 500);
    expect(game.state.phaseEndsAt).toBe(T0 + COUNTDOWN_MS);
    expect(game.view(ids[0], T0).round).toEqual({ index: 1, total: 2, waiting: false });

    // Ready late: clients get MEDIA_SETTLE_MS after the upload.
    const late = new Game(newRoom('ABC234', 'inst', T0), sequenceRandom());
    const [p1, p2] = ['Host', 'Bea'].map((name) => late.join({ kind: 'guest' }, name, T0));
    for (const p of [p1, p2]) late.connect(p.id, T0);
    giveDecks(late, [p1.id, p2.id]);
    for (const p of [p1, p2]) late.setReady(p.id, true, T0);
    late.start(p1.id, T0);
    const lateSlot = slotFor(late, 1);
    late.markReady(lateSlot.ownerID, lateSlot.id, 'photo', T0 + 2_500);
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
    expect(errStatus(() => game.markReady(other, slot.id, 'photo', T0 + 1))).toBe(409);
    expect(errStatus(() => game.markReady(slot.ownerID, 'not-a-slot', 'photo', T0 + 1))).toBe(409);
    game.markReady(slot.ownerID, slot.id, 'photo', T0 + 1);
    expect(errStatus(() => game.markReady(slot.ownerID, slot.id, 'photo', T0 + 2))).toBe(409);
  });

  it('rejects an item that does not fit the media mode', () => {
    const { game, ids } = core(['Host', 'Bea']);
    game.updateSettings(ids[0], { mediaMode: 'photos' }, T0);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    expect(errStatus(() => game.markReady(slot.ownerID, slot.id, 'video', T0 + 1))).toBe(422);
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
    expect(game.turnRequests).toEqual([{ playerID: second, slot: slot.id, game: 1, round: 1, mode: 'both' }]);

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

describe('reveal, guesses, and scoring', () => {
  it('shows the owner and everyone else exactly the same reveal', () => {
    const { game, ids } = core();
    game.updateSettings(ids[0], { rounds: 2 }, T0);
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
    game.markReady(slot.ownerID, slot.id, 'photo', T0);
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
    game.tick(round.endsAt!);
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
      { photos: 2, videos: 0 },
      { photos: 2, videos: 0 },
      { photos: 2, videos: 0 },
    ]);
  });
});

describe('hosts, leaving, and cleanup', () => {
  it('transfers host to the longest-present connected player on disconnect', () => {
    const { game, ids } = lobby(['Host', 'Bea', 'Cal']);
    game.disconnect(ids[1], T0);
    game.disconnect(ids[0], T0);
    expect(game.state.hostID).toBe(ids[2]);
    game.connect(ids[1], T0);
    game.disconnect(ids[2], T0);
    expect(game.state.hostID).toBe(ids[1]);
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
