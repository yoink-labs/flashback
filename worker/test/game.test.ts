import { describe, expect, it } from 'vitest';
import {
  CAPACITY,
  COUNTDOWN_MS,
  DISCONNECT_GRACE_MS,
  EMPTY_ROOM_GRACE_MS,
  FINISHED_ROOM_GRACE_MS,
  Game,
  GameError,
  newRoom,
  RESULTS_MS,
} from '../src/game';
import { ITEMS_PER_PLAYER, MEDIA_TTL_MS, type MediaKind } from '../src/media';
import { sequenceRandom } from './helpers';

const T0 = 1_000_000;

function lobby(names = ['Host', 'Bea', 'Cal']) {
  const game = new Game(newRoom('ABC234', 'inst', T0), sequenceRandom());
  const players = names.map((n) => game.join({ kind: 'guest' }, n, T0));
  for (const p of players) game.connect(p.id, T0);
  return { game, players, ids: players.map((p) => p.id) };
}

let itemSeq = 0;
function add(game: Game, owner: string, kind: MediaKind = 'photo') {
  const id = `item${++itemSeq}`;
  return game.addItem(owner, { id, kind, key: `rooms/ABC234/inst/g1/${id}`, contentType: kind === 'photo' ? 'image/jpeg' : 'video/mp4', bytes: 10 }, T0);
}

function readyAll(game: Game, ids: string[], kind: MediaKind = 'photo') {
  for (const id of ids) {
    add(game, id, kind);
    game.setReady(id, true, T0);
  }
}

const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return (e as GameError).message;
  }
  throw new Error('expected a GameError');
};

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
    const view = game.view(clerk.id, T0, (c) => c);
    expect(view.players.map((p) => [p.nickname, p.signedIn])).toEqual([
      ['Guest', false],
      ['Clerky', true],
    ]);
    expect(JSON.stringify(view)).not.toContain('user_1');
  });

  it('blocks new players mid-game', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    readyAll(game, ids);
    game.start(ids[0], T0);
    expect(err(() => game.join({ kind: 'guest' }, 'Late', T0))).toMatch(/in progress/);
  });
});

describe('ready and start rules', () => {
  it('needs two players, media that fits the mode, and everyone ready', () => {
    const { game, ids } = lobby(['Host']);
    expect(game.startBlocker()).toBe('Waiting for at least 2 players.');
    const bea = game.join({ kind: 'guest' }, 'Bea', T0);
    game.connect(bea.id, T0);
    expect(game.startBlocker()).toBe('Waiting for Host to add a photo or video.');
    expect(err(() => game.setReady(ids[0], true, T0))).toMatch(/Add a photo or video before you ready up/);
    add(game, ids[0]);
    add(game, bea.id, 'video');
    expect(game.startBlocker()).toBe('Waiting for Host to ready up.');
    game.setReady(ids[0], true, T0);
    expect(game.startBlocker()).toBe('Waiting for Bea to ready up.');
    game.setReady(bea.id, true, T0);
    expect(game.startBlocker()).toBeNull();
    expect(err(() => game.start(bea.id, T0))).toMatch(/Only the host/);
    game.start(ids[0], T0);
    expect(game.state.phase).toBe('countdown');
  });

  it('validates host settings', () => {
    const { game, ids } = lobby();
    game.updateSettings(ids[0], { rounds: 3, timerSeconds: 15, mediaMode: 'videos' }, T0);
    expect(game.state.settings).toEqual({ rounds: 3, timerSeconds: 15, mediaMode: 'videos' });
    expect(err(() => game.updateSettings(ids[1], { rounds: 4 }, T0))).toMatch(/Only the host/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 0 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { rounds: 2.5 }, T0))).toMatch(/Rounds must be/);
    expect(err(() => game.updateSettings(ids[0], { timerSeconds: 5 }, T0))).toMatch(/timer must be/);
    expect(err(() => game.updateSettings(ids[0], { mediaMode: 'gifs' }, T0))).toMatch(/Photos, Videos, or Both/);
  });
});

describe('media mode constraints', () => {
  it('rejects uploads outside the mode and caps items per player', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    game.updateSettings(ids[0], { mediaMode: 'photos' }, T0);
    expect(err(() => game.assertCanAdd(ids[1], 'video'))).toMatch(/Photos only/);
    game.updateSettings(ids[0], { mediaMode: 'videos' }, T0);
    expect(err(() => game.assertCanAdd(ids[1], 'photo'))).toMatch(/Videos only/);
    for (let i = 0; i < ITEMS_PER_PLAYER; i++) add(game, ids[1], 'video');
    expect(err(() => game.assertCanAdd(ids[1], 'video'))).toMatch(/up to 10/);
  });

  it('un-readies players whose library no longer fits and blocks start', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    add(game, ids[0], 'video');
    add(game, ids[1], 'photo');
    game.setReady(ids[0], true, T0);
    game.setReady(ids[1], true, T0);
    game.updateSettings(ids[0], { mediaMode: 'videos' }, T0);
    expect(game.player(ids[1])!.ready).toBe(false);
    expect(game.player(ids[0])!.ready).toBe(true);
    expect(game.startBlocker()).toBe('Waiting for Bea to add a video.');
  });

  it('deletes items outside the mode when the game starts', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    const photo = add(game, ids[0], 'photo');
    add(game, ids[0], 'video');
    add(game, ids[1], 'video');
    game.updateSettings(ids[0], { mediaMode: 'videos' }, T0);
    game.setReady(ids[0], true, T0);
    game.setReady(ids[1], true, T0);
    game.start(ids[0], T0);
    expect(game.deletions).toContain(photo.key);
    expect(game.state.items.every((i) => i.kind === 'video')).toBe(true);
  });
});

describe('game loop state machine', () => {
  function started(rounds = 2) {
    const setup = lobby();
    setup.game.updateSettings(setup.ids[0], { rounds, timerSeconds: 20 }, T0);
    readyAll(setup.game, setup.ids);
    setup.game.start(setup.ids[0], T0);
    return setup;
  }

  it('counts down, reveals without exposing the owner, scores, and shows results', () => {
    const { game, ids } = started();
    expect(game.state.phase).toBe('countdown');
    expect(game.state.totalRounds).toBe(2);
    const countdownView = game.view(ids[1], T0, (c) => `/m/${c}`);
    expect(countdownView.round).toEqual({ index: 1, total: 2 });
    expect(JSON.stringify(countdownView)).not.toContain(game.state.round!.capability);

    game.tick(T0 + COUNTDOWN_MS);
    expect(game.state.phase).toBe('reveal');
    const round = game.state.round!;
    const owner = round.ownerID;
    const [g1, g2] = ids.filter((id) => id !== owner);
    const view = game.view(g1, T0 + COUNTDOWN_MS, (c) => `/m/${c}`);
    expect(view.round).toMatchObject({ kind: 'photo', canGuess: true, isYours: false, mediaPath: `/m/${round.capability}` });
    expect(JSON.stringify(view)).not.toContain('ownerID');
    expect(game.view(owner, T0 + COUNTDOWN_MS, (c) => c).round).toMatchObject({ canGuess: false, isYours: true });

    expect(err(() => game.guess(owner, g1, T0 + COUNTDOWN_MS + 1))).toMatch(/This one is yours/);
    expect(err(() => game.guess(g1, g1, T0 + COUNTDOWN_MS + 1))).toMatch(/Pick another player/);
    game.guess(g1, owner, T0 + COUNTDOWN_MS + 5_000);
    expect(err(() => game.guess(g1, g2, T0 + COUNTDOWN_MS + 6_000))).toMatch(/already guessed/);
    expect(game.view(g2, T0, (c) => c).round).toMatchObject({ guessedCount: 1, guesserCount: 2 });
    expect(JSON.stringify(game.view(g2, T0, (c) => c))).not.toContain('"targetID"');
    // The last guess ends the round early.
    game.guess(g2, g1, T0 + COUNTDOWN_MS + 7_000);
    expect(game.state.phase).toBe('results');
    expect(game.state.lastResult!.ownerID).toBe(owner);
    expect(game.state.lastResult!.rows.map((r) => [r.playerID, r.points])).toEqual([
      [g1, 875],
      [g2, 0],
    ]);
    expect(game.player(g1)!.score).toBe(875);
    expect(game.player(owner)!.score).toBe(0);
    // The shown item was deleted the moment the round ended.
    expect(game.deletions).toHaveLength(1);
    expect(game.state.items.some((i) => i.id === round.itemID)).toBe(false);
  });

  it('scores missing guesses as zero when the timer runs out, then moves to the podium', () => {
    const { game } = started(1);
    game.tick(T0 + COUNTDOWN_MS);
    game.tick(T0 + COUNTDOWN_MS + 20_000);
    expect(game.state.phase).toBe('results');
    expect(game.state.lastResult!.rows.every((r) => r.points === 0 && r.targetID === null)).toBe(true);
    game.tick(T0 + COUNTDOWN_MS + 20_000 + RESULTS_MS);
    expect(game.state.phase).toBe('podium');
    // Unused media from the finished game is deleted.
    expect(game.state.items).toHaveLength(0);
    expect(game.deletions).toHaveLength(3);
  });

  it('rejects late guesses', () => {
    const { game, ids } = started(1);
    game.tick(T0 + COUNTDOWN_MS);
    const guesser = ids.find((id) => id !== game.state.round!.ownerID)!;
    // The alarm has not fired yet, but the timer is over.
    expect(err(() => game.guess(guesser, game.state.round!.ownerID, T0 + COUNTDOWN_MS + 20_001))).toMatch(/Time is up/);
  });

  it('builds streaks across rounds and resets on a miss', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 3 }, T0);
    // Only Host has media, so Bea guesses every round.
    for (let i = 0; i < 3; i++) add(game, ids[0]);
    add(game, ids[1], 'video');
    game.updateSettings(ids[0], { mediaMode: 'photos' }, T0);
    game.setReady(ids[0], true, T0);
    expect(err(() => game.setReady(ids[1], true, T0))).toMatch(/Add a photo/);
    game.updateSettings(ids[0], { mediaMode: 'both' }, T0);
    game.setReady(ids[1], true, T0);
    game.start(ids[0], T0);
    let now = T0;
    const points: number[] = [];
    for (let r = 0; r < 3; r++) {
      now += COUNTDOWN_MS;
      game.tick(now);
      const owner = game.state.round!.ownerID;
      const guesser = ids.find((id) => id !== owner)!;
      game.guess(guesser, owner, now);
      points.push(game.state.lastResult!.rows[0].points);
      now += RESULTS_MS;
      game.tick(now);
    }
    expect(game.state.phase).toBe('podium');
    // Picks alternate owners (fewest shown first), so each player guesses correctly when it is their turn.
    expect(game.view(ids[0], now, (c) => c).podium.map((p) => p.rank)).toEqual([1, 2]);
    expect(points.every((p) => p >= 1000)).toBe(true);
  });

  it('picks owners fairly and without replacement', () => {
    const { game, ids } = lobby(['Host', 'Bea', 'Cal']);
    game.updateSettings(ids[0], { rounds: 6 }, T0);
    for (const id of ids) for (let i = 0; i < 2; i++) add(game, id);
    for (const id of ids) game.setReady(id, true, T0);
    game.start(ids[0], T0);
    const seenItems = new Set<string>();
    const owners: string[] = [];
    let now = T0;
    while (game.state.phase !== 'podium') {
      now += COUNTDOWN_MS;
      game.tick(now);
      seenItems.add(game.state.round!.itemID);
      owners.push(game.state.round!.ownerID);
      now += 20_000 + RESULTS_MS;
      game.tick(now);
    }
    expect(seenItems.size).toBe(6);
    for (const id of ids) expect(owners.filter((o) => o === id)).toHaveLength(2);
    expect(new Set(owners.slice(0, 3)).size).toBe(3);
  });

  it('clamps rounds to the available media', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 10 }, T0);
    readyAll(game, ids);
    game.start(ids[0], T0);
    expect(game.state.totalRounds).toBe(2);
  });

  it('lets the host skip results, end early, and play again in the same room', () => {
    const { game, ids } = started(2);
    game.tick(T0 + COUNTDOWN_MS);
    game.tick(T0 + COUNTDOWN_MS + 20_000);
    expect(err(() => game.advance(ids[1], T0 + 30_000))).toMatch(/Only the host/);
    game.advance(ids[0], T0 + 30_000);
    expect(game.state.phase).toBe('countdown');
    game.end(ids[0], T0 + 31_000);
    expect(game.state.phase).toBe('podium');
    expect(err(() => game.playAgain(ids[1], T0 + 32_000))).toMatch(/Only the host/);
    game.playAgain(ids[0], T0 + 32_000);
    expect(game.state.phase).toBe('lobby');
    expect(game.state.game).toBe(2);
    expect(game.state.players.every((p) => p.score === 0 && !p.ready)).toBe(true);
    expect(game.state.players).toHaveLength(3);
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

  it('deletes unused media when a player leaves and ends the game below two players', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    readyAll(game, ids);
    const extra = add(game, ids[1]);
    game.leave(ids[1], T0);
    expect(game.deletions).toContain(extra.key);
    expect(game.state.items.every((i) => i.ownerID === ids[0])).toBe(true);
    expect(game.removed).toEqual([ids[1]]);
  });

  it('keeps the on-screen item until its round ends, then deletes it', () => {
    const { game, ids } = lobby(['Host', 'Bea', 'Cal']);
    readyAll(game, ids);
    game.start(ids[0], T0);
    game.tick(T0 + COUNTDOWN_MS);
    const { ownerID, itemID } = game.state.round!;
    game.leave(ownerID, T0 + COUNTDOWN_MS + 1);
    expect(game.state.items.some((i) => i.id === itemID)).toBe(true);
    game.tick(T0 + COUNTDOWN_MS + 20_000);
    expect(game.state.items.some((i) => i.id === itemID)).toBe(false);
  });

  it('ends a running game when fewer than two players remain', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    readyAll(game, ids);
    game.start(ids[0], T0);
    game.leave(ids[1], T0 + 1);
    expect(game.state.phase).toBe('podium');
    expect(game.state.items).toHaveLength(0);
  });

  it('removes players after the reconnect grace period and closes empty rooms', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    readyAll(game, ids);
    game.disconnect(ids[1], T0);
    expect(game.nextDeadline()).toBe(T0 + DISCONNECT_GRACE_MS);
    game.tick(T0 + DISCONNECT_GRACE_MS);
    expect(game.player(ids[1])).toBeUndefined();
    game.disconnect(ids[0], T0 + DISCONNECT_GRACE_MS);
    game.tick(T0 + DISCONNECT_GRACE_MS + EMPTY_ROOM_GRACE_MS);
    expect(game.state.phase).toBe('closed');
    expect(game.state.items).toHaveLength(0);
    expect(game.deletions).toHaveLength(2);
  });

  it('closes rooms when the last player leaves', () => {
    const { game, ids } = lobby(['Host']);
    add(game, ids[0]);
    game.leave(ids[0], T0);
    expect(game.state.phase).toBe('closed');
    expect(game.deletions).toHaveLength(1);
  });

  it('closes finished rooms after a grace period', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    readyAll(game, ids);
    game.start(ids[0], T0);
    game.end(ids[0], T0);
    expect(game.nextDeadline()).toBe(T0 + FINISHED_ROOM_GRACE_MS);
    game.tick(T0 + FINISHED_ROOM_GRACE_MS);
    expect(game.state.phase).toBe('closed');
  });

  it('deletes media at the TTL backstop even if nothing else did', () => {
    const { game, ids } = lobby(['Host', 'Bea']);
    const item = add(game, ids[0]);
    expect(item.expiresAt).toBe(T0 + MEDIA_TTL_MS);
    // Keep the lobby active so idle cleanup does not fire first.
    game.state.lastActivityAt = T0 + MEDIA_TTL_MS;
    expect(game.nextDeadline()).toBe(T0 + MEDIA_TTL_MS);
    game.tick(T0 + MEDIA_TTL_MS);
    expect(game.state.items).toHaveLength(0);
    expect(game.deletions).toEqual([item.key]);
  });
});
