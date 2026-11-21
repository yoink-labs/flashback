// Game-level rules for Milestone 4: Even Split, its schedule and fallbacks,
// live bunch sizes, streak effects and round effects, and the private/public
// shape of the view. Shop, 50/50 and Double Down live in arcade-shop.test.ts.
import { describe, expect, it } from 'vitest';
import { PHOTO_BUNCH, VIDEO_BUNCH } from '../src/bunch';
import { Game, newRoom, type RoomState } from '../src/game';
import { defaultSettings } from '../src/settings';
import { defaultPowerups } from '../src/shop';
import { T0, effectsWith, err, errStatus, finishRound, gameWith, guessAll, leaveResults, playRound, revealRound, slotFor, started } from './game-helpers';

describe('Even Split bunches', () => {
  it('exposes the room requirement and updates it as players join, leave, and settings change', () => {
    const { game, ids } = gameWith(['Host', 'Bea']);
    expect(game.view(ids[0], T0).bunch).toEqual({ photos: PHOTO_BUNCH, videos: VIDEO_BUNCH });

    game.updateSettings(ids[0], { rounds: 10, evenSplit: true }, T0);
    // 10 / 2 = 5 each: 3 photos + 2 videos.
    expect(game.view(ids[0], T0).bunch).toEqual({ photos: 3, videos: 2 });

    const third = game.join({ kind: 'guest' }, 'Cal', T0);
    game.connect(third.id, T0);
    // 10 / 3 → a share of 4: 3 photos + 1 video.
    expect(game.view(ids[1], T0).bunch).toEqual({ photos: 3, videos: 1 });

    game.leave(third.id, T0);
    expect(game.view(ids[1], T0).bunch).toEqual({ photos: 3, videos: 2 });

    game.updateSettings(ids[0], { mediaMode: 'photos' }, T0);
    expect(game.view(ids[0], T0).bunch).toEqual({ photos: 5, videos: 0 });
    game.updateSettings(ids[0], { mediaMode: 'videos' }, T0);
    expect(game.view(ids[0], T0).bunch).toEqual({ photos: 0, videos: 5 });
    game.updateSettings(ids[0], { rounds: 100 }, T0);
    expect(game.view(ids[0], T0).bunch).toEqual({ photos: 0, videos: 50 });
    game.updateSettings(ids[0], { evenSplit: false, mediaMode: 'both' }, T0);
    expect(game.view(ids[0], T0).bunch).toEqual({ photos: PHOTO_BUNCH, videos: VIDEO_BUNCH });
  });

  it('keeps readiness when the requirement grows, and only blocks the start', () => {
    const { game, ids } = gameWith(['Host', 'Bea', 'Cal']);
    game.updateSettings(ids[0], { rounds: 10, evenSplit: true }, T0);
    for (const id of ids) game.setDeck(id, 3, 1, T0);
    for (const id of ids) game.setReady(id, true, T0);
    expect(game.startBlocker()).toBeNull();

    // Leaving makes every remaining bunch bigger: 3 photos and 2 videos.
    game.leave(ids[2], T0 + 1);
    expect(game.view(ids[0], T0 + 1).bunch).toEqual({ photos: 3, videos: 2 });
    expect(game.player(ids[0])!.ready).toBe(true);
    expect(game.player(ids[1])!.ready).toBe(true);
    expect(game.startBlocker()).toBe('Add 1 more video');

    // Raising the round count grows it further; ready players stay ready.
    game.updateSettings(ids[0], { rounds: 100 }, T0 + 2);
    expect(game.view(ids[0], T0 + 2).bunch).toEqual({ photos: 33, videos: 17 });
    expect(game.player(ids[0])!.ready).toBe(true);
    expect(game.player(ids[1])!.ready).toBe(true);
    expect(game.startBlocker()).toMatch(/Deal 33 photos|Add 30 more photos/);

    for (const id of [ids[0], ids[1]]) game.setDeck(id, 33, 17, T0 + 3);
    expect(game.startBlocker()).toBeNull();
    expect(game.player(ids[0])!.ready).toBe(true);
  });

  it('checks readiness against the live requirement', () => {
    const { game, ids } = gameWith(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 10, evenSplit: true, mediaMode: 'photos' }, T0);
    game.setDeck(ids[1], 4, 0, T0);
    expect(err(() => game.setReady(ids[1], true, T0))).toBe('Add 1 more photo before you ready up.');
    game.setDeck(ids[1], 5, 0, T0);
    game.setReady(ids[1], true, T0);
    expect(game.player(ids[1])!.ready).toBe(true);
  });
});

describe('the Even Split schedule', () => {
  it('is written at start and drives the slots that are opened', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal'], { rounds: 7, evenSplit: true, mediaMode: 'photos' });
    const schedule = game.state.schedule!;
    expect(schedule).toHaveLength(7);
    expect(schedule.every((entry) => entry.kind === 'photo')).toBe(true);
    expect([...new Set(schedule.map((entry) => entry.ownerID))].sort()).toEqual([...ids].sort());

    for (const slot of game.state.slots) {
      expect(slot.kind).toBeUndefined();
      expect(slot.ownerID).toBe(schedule[slot.round - 1].ownerID);
      expect(slot.requiredKind).toBe(schedule[slot.round - 1].kind);
    }

    // Shares stay hidden: no schedule, slot ids, or owner ids of open rounds.
    const view = game.view(ids[1], T0);
    expect(JSON.stringify(view)).not.toContain('schedule');
    expect(JSON.stringify(view)).not.toMatch(/ownerID|requiredKind|"slot"/);
    const serializedRound = JSON.stringify(view.round);
    for (const slot of game.state.slots) expect(serializedRound).not.toContain(slot.ownerID);
  });

  it('spreads rounds evenly and keeps back-to-back owners apart', () => {
    const { game } = started(['Host', 'Bea', 'Cal'], { rounds: 9, evenSplit: true, mediaMode: 'photos' });
    const schedule = game.state.schedule!;
    const owned = new Map<string, number>();
    for (const entry of schedule) owned.set(entry.ownerID, (owned.get(entry.ownerID) ?? 0) + 1);
    expect([...owned.values()].sort()).toEqual([3, 3, 3]);
    for (let i = 1; i < schedule.length; i++) expect(schedule[i].ownerID).not.toBe(schedule[i - 1].ownerID);
  });

  it('supports a 100-round Even Split game with a 33/17 bunch', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 100, evenSplit: true }, { photos: 33, videos: 17 });
    expect(game.state.totalRounds).toBe(100);
    expect(game.state.schedule).toHaveLength(100);
    expect(game.view(ids[0], T0).bunch).toEqual({ photos: 33, videos: 17 });
    const counts = new Map<string, number>();
    for (const entry of game.state.schedule!) counts.set(entry.ownerID, (counts.get(entry.ownerID) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([50, 50]);
    expect(game.state.slots.map((slot) => slot.round)).toEqual([1, 2]);
  });

  it('falls back to the normal pick, keeping the scheduled kind, when the owner passes', () => {
    const { game } = started(['Host', 'Bea', 'Cal'], { rounds: 6, evenSplit: true, mediaMode: 'photos' });
    const slot = slotFor(game, 2);
    const scheduledOwner = slot.ownerID;
    const kind = slot.requiredKind;
    game.turnRequests.length = 0;

    game.pass(scheduledOwner, slot.id, T0 + 1);
    expect(slot.ownerID).not.toBe(scheduledOwner);
    expect(slot.requiredKind).toBe(kind);
    expect(game.turnRequests.map((turn) => [turn.playerID, turn.kind])).toEqual([[slot.ownerID, kind]]);
  });

  it('falls back when the scheduled owner disconnects or leaves', () => {
    const disconnected = started(['Host', 'Bea', 'Cal'], { rounds: 6, evenSplit: true, mediaMode: 'photos' });
    const slot = slotFor(disconnected.game, 2);
    const scheduledOwner = slot.ownerID;
    const kind = slot.requiredKind;
    disconnected.game.disconnect(scheduledOwner, T0 + 1);
    expect(slot.ownerID).not.toBe(scheduledOwner);
    expect(slot.requiredKind).toBe(kind);

    const left = started(['Host', 'Bea', 'Cal'], { rounds: 6, evenSplit: true, mediaMode: 'photos' });
    const leftSlot = slotFor(left.game, 2);
    const leaver = leftSlot.ownerID;
    left.game.leave(leaver, T0 + 1);
    expect(leftSlot.ownerID).not.toBe(leaver);
    expect(leftSlot.requiredKind).toBe(kindFor(left.game, 2));
  });

  function kindFor(game: Game, round: number) {
    return game.state.schedule![round - 1].kind;
  }

  it('falls back for a future round whose scheduled owner left at the start', () => {
    const { game } = started(['Host', 'Bea', 'Cal'], { rounds: 6, evenSplit: true, mediaMode: 'photos' });
    const schedule = game.state.schedule!;
    const targetRound = 5;
    const scheduledOwner = schedule[targetRound - 1].ownerID;
    game.leave(scheduledOwner, T0 + 1);

    for (let round = 1; round < targetRound; round++) {
      playRound(game);
      leaveResults(game);
    }
    // Round 5's slot opened as round 4's reveal began.
    const slot = slotFor(game, targetRound);
    expect(slot.ownerID).not.toBe(scheduledOwner);
    expect(slot.requiredKind).toBe(schedule[targetRound - 1].kind);
    expect(slot.ownerID).not.toBe('');
  });
});

describe('streak effects at the reveal', () => {
  it('decides private effects per guesser and never gives the owner one', () => {
    const { game, ids } = gameWith();
    game.updateSettings(
      ids[0],
      {
        rounds: 2,
        mediaMode: 'photos',
        effects: effectsWith({
          greyscale: { enabled: true, trigger: 'right', after: 2 },
          blur: { enabled: true, trigger: 'right', after: 3, strength: 'heavy' },
        }),
      },
      T0,
    );
    for (const id of ids) game.setDeck(id, PHOTO_BUNCH, VIDEO_BUNCH, T0);
    for (const id of ids) game.setReady(id, true, T0);
    game.start(ids[0], T0);

    const slot = slotFor(game, 1);
    const owner = slot.ownerID;
    const others = ids.filter((id) => id !== owner);
    game.markReady(owner, slot.id, slot.requiredKind, T0);
    game.player(owner)!.streak = 9;
    game.player(others[0])!.streak = 2;
    game.player(others[1])!.streak = 3;
    game.tick(game.state.phaseEndsAt!);
    expect(game.state.phase).toBe('reveal');

    expect(game.view(owner, T0).round!.yourEffect).toBeNull();
    expect(game.view(others[0], T0).round!.yourEffect).toEqual({ kind: 'greyscale', trigger: 'right', streak: 2 });
    expect(game.view(others[1], T0).round!.yourEffect).toEqual({ kind: 'blur', strength: 'heavy', trigger: 'right', streak: 3 });
    // The round effect is shared and off here.
    for (const id of ids) expect(game.view(id, T0).round!.effect).toBeNull();
    // The owner is still never exposed, even with an effect field in play.
    for (const id of ids) expect(JSON.stringify(game.view(id, T0).round)).not.toContain(owner);

    guessAll(game);
    const rows = Object.fromEntries(game.state.lastResult!.rows.map((row) => [row.playerID, row]));
    expect(rows[owner]).toMatchObject({ effect: null, points: 0 });
    expect(rows[others[0]]).toMatchObject({ effect: 'greyscale', roundEffect: null });
    expect(rows[others[1]]).toMatchObject({ effect: 'blur' });
  });

  it('watches a wrong streak when the trigger is wrong', () => {
    const { game, ids } = gameWith(['Host', 'Bea']);
    game.updateSettings(ids[0], { rounds: 1, mediaMode: 'photos', effects: effectsWith({ greyscale: { enabled: true, trigger: 'wrong', after: 2 } }) }, T0);
    for (const id of ids) game.setDeck(id, PHOTO_BUNCH, VIDEO_BUNCH, T0);
    for (const id of ids) game.setReady(id, true, T0);
    game.start(ids[0], T0);
    const slot = slotFor(game, 1);
    const guesser = ids.find((id) => id !== slot.ownerID)!;
    game.player(guesser)!.missStreak = 2;
    const round = revealRound(game);
    expect(game.view(guesser, T0).round!.yourEffect).toEqual({ kind: 'greyscale', trigger: 'wrong', streak: 2 });
    expect(game.view(round.ownerID, T0).round!.yourEffect).toBeNull();
    guessAll(game);
    const row = game.state.lastResult!.rows.find((r) => r.playerID === guesser)!;
    expect(row.effect).toBe('greyscale');
    // A correct guess resets the wrong streak after the effect was shown.
    expect(game.player(guesser)!.missStreak).toBe(0);
  });
});

describe('round effects and sharp eyes', () => {
  it('runs one focus for every viewer and pays for guessing early', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal'], {
      rounds: 2,
      timerSeconds: 20,
      mediaMode: 'photos',
      effects: effectsWith({ focus: { enabled: true, frequency: 'every', span: 100 } }),
    });
    const slot = slotFor(game, 1);
    const owner = slot.ownerID;
    const others = ids.filter((id) => id !== owner);
    const round = revealRound(game);
    expect(round.effect).toEqual({ kind: 'focus', spanMs: 20_000 });
    for (const id of ids) expect(game.view(id, round.revealAt!).round!.effect).toEqual({ kind: 'focus', spanMs: 20_000 });

    const revealAt = round.revealAt!;
    game.guess(others[0], owner, revealAt + 5_000);
    game.guess(others[1], owner, revealAt + 19_000);
    game.guess(owner, owner, revealAt);
    expect(game.state.phase).toBe('results');

    const rows = Object.fromEntries(game.state.lastResult!.rows.map((row) => [row.playerID, row]));
    // 500 accuracy + 375 speed + 150 sharp eyes.
    expect(rows[others[0]]).toMatchObject({ points: 1_025, bonus: 150, roundEffect: 'focus', correct: true });
    // 500 accuracy + 25 speed + 10 sharp eyes.
    expect(rows[others[1]]).toMatchObject({ points: 535, bonus: 10, roundEffect: 'focus' });
    expect(rows[owner]).toMatchObject({ points: 0, bonus: 0, roundEffect: 'focus' });
  });

  it('pays no sharp eyes once the effect has finished', () => {
    const { game, ids } = started(['Host', 'Bea'], {
      rounds: 1,
      timerSeconds: 20,
      mediaMode: 'photos',
      effects: effectsWith({ focus: { enabled: true, frequency: 'every', span: 25 } }),
    });
    const round = revealRound(game);
    expect(round.effect).toEqual({ kind: 'focus', spanMs: 5_000 });
    const owner = round.ownerID;
    const guesser = ids.find((id) => id !== owner)!;
    game.guess(guesser, owner, round.revealAt! + 6_000);
    game.guess(owner, owner, round.revealAt! + 6_000);
    const row = game.state.lastResult!.rows.find((r) => r.playerID === guesser)!;
    // 500 accuracy + 350 speed; the effect was over 1 s ago.
    expect(row).toMatchObject({ points: 850, bonus: 0, roundEffect: 'focus' });
  });

  it('zooms out from a random point in the middle half', () => {
    const { game } = started(['Host', 'Bea'], {
      rounds: 1,
      timerSeconds: 20,
      mediaMode: 'photos',
      effects: effectsWith({ zoom: { enabled: true, frequency: 'every', span: 50, scale: 3 } }),
    });
    const round = revealRound(game);
    expect(round.effect).toMatchObject({ kind: 'zoom', spanMs: 10_000, scale: 3 });
    const effect = round.effect as { originX: number; originY: number };
    expect(effect.originX).toBeGreaterThanOrEqual(0.25);
    expect(effect.originX).toBeLessThanOrEqual(0.75);
    expect(effect.originY).toBeGreaterThanOrEqual(0.25);
    expect(effect.originY).toBeLessThanOrEqual(0.75);
    guessAll(game);
    expect(game.state.lastResult!.rows.every((row) => row.roundEffect === 'zoom')).toBe(true);
  });

  it('keeps effects off when the settings are off', () => {
    const { game } = started(['Host', 'Bea'], { rounds: 1, mediaMode: 'photos' });
    const round = revealRound(game);
    expect(round.effect).toBeNull();
    guessAll(game);
    expect(game.state.lastResult!.rows.every((row) => row.roundEffect === null && row.bonus === 0)).toBe(true);
  });

  it('plays a half-frequency effect only on a coin flip', () => {
    const settings = { rounds: 1, mediaMode: 'photos', effects: effectsWith({ focus: { enabled: true, frequency: 'half', span: 50 } }) };
    const fixed = (value: number) => {
      let n = 0;
      return { float: () => value, id: () => `fixed${++n}` };
    };
    expect(revealRound(started(['Host', 'Bea'], settings, undefined, fixed(0.1)).game).effect).toEqual({ kind: 'focus', spanMs: 10_000 });
    expect(revealRound(started(['Host', 'Bea'], settings, undefined, fixed(0.9)).game).effect).toBeNull();
  });
});

describe('missStreak', () => {
  it('counts wrong and missing guesses, resets on a correct one, and ignores own rounds', () => {
    const { game, ids } = gameWith();
    game.updateSettings(ids[0], { rounds: 3, timerSeconds: 10, mediaMode: 'photos' }, T0);
    for (const id of ids) game.setDeck(id, PHOTO_BUNCH, VIDEO_BUNCH, T0);
    for (const id of ids) game.setReady(id, true, T0);
    game.start(ids[0], T0);

    // Round 1: one non-owner guesses wrong, the other misses the timer.
    let round = revealRound(game);
    const owner1 = round.ownerID;
    const [wrong, missing] = ids.filter((id) => id !== owner1);
    game.guess(wrong, wrong, round.revealAt! + 1_000); // a self-guess is wrong here
    finishRound(game);
    expect(game.player(wrong)!.missStreak).toBe(1);
    expect(game.player(missing)!.missStreak).toBe(1);
    expect(game.player(owner1)!.missStreak).toBe(0);
    // The owner's decoy guess never touches their streaks.
    expect(game.player(owner1)!.streak).toBe(0);

    // Round 2: capture the owner's counters, then have a non-owner be correct.
    leaveResults(game);
    round = revealRound(game);
    const owner2 = round.ownerID;
    const correct = ids.find((id) => id !== owner2)!;
    const other = ids.find((id) => id !== owner2 && id !== correct)!;
    const ownerBefore = { streak: game.player(owner2)!.streak, miss: game.player(owner2)!.missStreak };
    const otherBefore = game.player(other)!.missStreak;
    game.guess(correct, owner2, round.revealAt! + 1_000);
    game.guess(owner2, correct, round.revealAt! + 1_000); // owner's wrong decoy
    finishRound(game);
    expect(game.player(correct)!.missStreak).toBe(0);
    expect(game.player(correct)!.streak).toBe(1);
    expect(game.player(other)!.missStreak).toBe(otherBefore + 1);
    expect(game.player(owner2)!.streak).toBe(ownerBefore.streak);
    expect(game.player(owner2)!.missStreak).toBe(ownerBefore.miss);
  });

  it('starts every player at zero and resets on Play Again', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 1, mediaMode: 'photos' });
    game.player(ids[1])!.missStreak = 4;
    playRound(game);
    leaveResults(game);
    expect(game.state.phase).toBe('podium');
    game.playAgain(ids[0], T0 + 60_000);
    expect(game.state.players.map((player) => player.missStreak)).toEqual([0, 0]);
  });
});

describe('view privacy and old state', () => {
  it('shows items publicly but effects and eliminations per viewer', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal'], {
      rounds: 1,
      mediaMode: 'photos',
      effects: effectsWith({ greyscale: { enabled: true, trigger: 'right', after: 2 } }),
      powerups: { ...defaultPowerups(), fiftyFifty: { enabled: true, after: 3 } },
    });
    game.player(ids[0])!.items = { doubleDown: 1, shield: 1, fiftyFifty: 2 };
    const round = revealRound(game);
    for (const id of ids) {
      expect(game.view(id, T0).players.find((player) => player.id === ids[0])!.items).toEqual({
        doubleDown: 1,
        shield: 1,
        fiftyFifty: 2,
      });
      expect(game.view(id, T0).shop).toBeNull();
    }
    expect(game.view(round.ownerID, T0).round).toMatchObject({ yourEffect: null, eliminated: [] });
    for (const id of ids) expect(game.view(id, T0).round!.effect).toBeNull();
  });

  it('normalizes a room persisted before M4 and gives result rows their defaults', () => {
    const state = newRoom('ABC234', 'inst', T0) as unknown as Record<string, unknown>;
    const game0 = new Game(state as unknown as RoomState);
    const players = ['Host', 'Bea'].map((name) => game0.join({ kind: 'guest' }, name, T0));
    for (const player of players) game0.connect(player.id, T0);
    // Strip every M4 field a pre-M4 build would not have persisted.
    delete (state.settings as Record<string, unknown>).evenSplit;
    delete (state.settings as Record<string, unknown>).effects;
    delete (state.settings as Record<string, unknown>).powerups;
    state.phase = 'reveal';
    state.round = {
      index: 1,
      slotID: 's1',
      ownerID: players[0].id,
      kind: 'photo',
      countdownStart: T0,
      revealAt: T0,
      endsAt: T0 + 20_000,
      guessers: [players[0].id, players[1].id],
      guesses: {},
    };
    state.lastResult = {
      index: 0,
      ownerID: players[0].id,
      kind: 'photo',
      rows: [{ playerID: players[1].id, targetID: null, correct: false, points: 0, accuracy: 0, speed: 0, streakBonus: 0, streak: 0, elapsedMs: null, total: 0 }],
    } as never;
    delete state.schedule;
    delete state.shopBought;
    for (const player of state.players as Record<string, unknown>[]) {
      delete player.items;
      delete player.missStreak;
    }

    const game = new Game(state as unknown as RoomState);
    expect(game.state.settings).toEqual(defaultSettings());
    expect(game.player(players[0].id)!.items).toEqual({ doubleDown: 0, shield: 0, fiftyFifty: 0 });
    expect(game.player(players[0].id)!.missStreak).toBe(0);
    expect(game.state.round!.effect).toBeNull();
    expect(game.state.round!.eliminated).toEqual({});
    expect(game.state.round!.streakEffects).toEqual({});
    expect(game.state.round!.fiftyFiftyUsed).toEqual({});
    const row = game.state.lastResult!.rows[0];
    expect(row).toMatchObject({ bonus: 0, doubleDown: null, shielded: false, effect: null, roundEffect: null, fiftyFifty: false, earnedFiftyFifty: false });
    // A view built from the old round must not crash on the missing fields.
    expect(game.view(players[1].id, T0).round).toMatchObject({ yourEffect: null, eliminated: [] });
  });

  it('rejects settings changes from guests and outside the lobby', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 2, mediaMode: 'photos' });
    expect(errStatus(() => game.updateSettings(ids[1], { rounds: 3 }, T0))).toBe(403);
    expect(errStatus(() => game.updateSettings(ids[0], { rounds: 3 }, T0))).toBe(409);
  });
});
