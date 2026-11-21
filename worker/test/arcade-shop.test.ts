// Game-level rules for Milestone 4's power-ups: 50/50 earning and use, the
// shop, Double Down, Shield, the score floor, results length, and the public /
// private view fields. Even Split and effects live in arcade.test.ts.
import { describe, expect, it } from 'vitest';
import { Game, newRoom, type RoundState } from '../src/game';
import { defaultPowerups, type PowerupsSettings } from '../src/shop';
import { effectsWith, err, errStatus, finishRound, guessAll, leaveResults, playRound, revealRound, slotFor, started, T0 } from './game-helpers';

const PRICES = { doubleDown: 250, shield: 200, fiftyFifty: 400 };

function powerupsWith(patch: { fiftyFifty?: Partial<PowerupsSettings['fiftyFifty']>; shop?: Partial<PowerupsSettings['shop']> }): PowerupsSettings {
  const base = defaultPowerups();
  return { fiftyFifty: { ...base.fiftyFifty, ...patch.fiftyFifty }, shop: { ...base.shop, ...patch.shop } };
}

const rowFor = (game: Game, playerID: string) => game.state.lastResult!.rows.find((row) => row.playerID === playerID)!;

/** Finishes a reveal by having everyone still in it guess the owner. */
function finishOthers(game: Game, round: RoundState) {
  for (const id of [...round.guessers]) {
    if (game.state.phase !== 'reveal') return;
    if (!round.guesses[id]) game.guess(id, round.ownerID, round.revealAt! + 200);
  }
  if (game.state.phase === 'reveal') game.tick(round.endsAt!);
}

describe('earning 50/50s', () => {
  it('earns one at each positive multiple, banks at most two, and keeps odd streaks empty', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal', 'Dee'], {
      rounds: 12,
      timerSeconds: 20,
      mediaMode: 'photos',
      powerups: powerupsWith({ fiftyFifty: { enabled: true, after: 2 } }),
    });
    const target = ids[1];
    const attempts = [
      { before: 1, earned: true, held: 1 },
      { before: 2, earned: false, held: 1 },
      { before: 3, earned: true, held: 2 },
      { before: 5, earned: false, held: 2 },
    ];
    let attempt = 0;
    for (let roundIndex = 1; roundIndex <= 12 && attempt < attempts.length; roundIndex++) {
      const round = revealRound(game);
      if (round.ownerID !== target) {
        const spec = attempts[attempt++];
        // The finish reads the streak the correct guess extends.
        game.player(target)!.streak = spec.before;
        game.guess(target, round.ownerID, round.revealAt! + 100);
        finishOthers(game, round);
        const row = rowFor(game, target);
        expect(row.earnedFiftyFifty, `attempt ${attempt}`).toBe(spec.earned);
        expect(row.streak).toBe(spec.before + 1);
        expect(game.player(target)!.items.fiftyFifty, `attempt ${attempt}`).toBe(spec.held);
      } else {
        finishOthers(game, round);
      }
      if (attempt < attempts.length && game.state.phase === 'results' && roundIndex < 12) leaveResults(game);
    }
    expect(attempt).toBe(attempts.length);
    expect(game.player(target)!.items.fiftyFifty).toBe(2);
  });

  it('honours a custom "after" and stays quiet when the power-up is off', () => {
    const custom = started(['Host', 'Bea'], { rounds: 1, mediaMode: 'photos', powerups: powerupsWith({ fiftyFifty: { enabled: true, after: 3 } }) });
    let round = revealRound(custom.game);
    let owner = round.ownerID;
    let guesser = custom.ids.find((id) => id !== owner)!;
    custom.game.player(guesser)!.streak = 2;
    custom.game.guess(guesser, owner, round.revealAt! + 100);
    custom.game.guess(owner, owner, round.revealAt! + 100);
    expect(rowFor(custom.game, guesser).earnedFiftyFifty).toBe(true);
    expect(custom.game.player(guesser)!.items.fiftyFifty).toBe(1);

    const off = started(['Host', 'Bea'], { rounds: 1, mediaMode: 'photos' });
    round = revealRound(off.game);
    owner = round.ownerID;
    guesser = off.ids.find((id) => id !== owner)!;
    off.game.player(guesser)!.streak = 2; // would be a multiple of the default 3
    off.game.guess(guesser, owner, round.revealAt! + 100);
    off.game.guess(owner, owner, round.revealAt! + 100);
    expect(rowFor(off.game, guesser).earnedFiftyFifty).toBe(false);
    expect(off.game.player(guesser)!.items.fiftyFifty).toBe(0);
  });
});

describe('using a 50/50', () => {
  it('spends one charge and greys out half the wrong choices, never the owner or the viewer', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal', 'Dee'], { rounds: 2, mediaMode: 'photos' });
    const round = revealRound(game);
    const owner = round.ownerID;
    const users = ids.filter((id) => id !== owner);
    const user = users[0];
    game.player(user)!.items.fiftyFifty = 1;
    expect(game.view(user, T0).round!.eliminated).toEqual([]);

    game.useFiftyFifty(user, round.revealAt! + 10);
    const eliminated = game.state.round!.eliminated[user];
    expect(eliminated).toHaveLength(1); // floor(2 / 2): the two non-owner others
    expect(eliminated).not.toContain(owner);
    expect(eliminated).not.toContain(user);
    // A player the 50/50 ruled out can't be picked.
    expect(errStatus(() => game.guess(user, eliminated[0], round.revealAt! + 15))).toBe(422);
    expect(game.state.round!.guesses[user]).toBeUndefined();
    expect(game.player(user)!.items.fiftyFifty).toBe(0);
    expect(game.view(user, T0).round!.eliminated).toEqual(eliminated);
    expect(game.view(users[1], T0).round!.eliminated).toEqual([]);

    expect(err(() => game.useFiftyFifty(user, round.revealAt! + 20))).toBe("You don't have a 50/50.");
    game.player(user)!.items.fiftyFifty = 1;
    expect(err(() => game.useFiftyFifty(user, round.revealAt! + 20))).toBe('You already used a 50/50 this round.');
    expect(err(() => game.useFiftyFifty(users[1], round.revealAt! + 20))).toBe("You don't have a 50/50.");

    // Using it after guessing is refused.
    game.player(users[1])!.items.fiftyFifty = 1;
    game.guess(users[1], owner, round.revealAt! + 50);
    expect(errStatus(() => game.useFiftyFifty(users[1], round.revealAt! + 60))).toBe(409);

    finishOthers(game, round);
    expect(rowFor(game, user)).toMatchObject({ fiftyFifty: true, earnedFiftyFifty: false });
    expect(rowFor(game, users[1])).toMatchObject({ fiftyFifty: false });
  });

  it('keeps the charge when there is nobody to cut', () => {
    // Three players: a guesser's wrong choices are just one other player.
    const { game, ids } = started(['Host', 'Bea', 'Cal'], { rounds: 2, mediaMode: 'photos' });
    const round = revealRound(game);
    const user = ids.find((id) => id !== round.ownerID)!;
    game.player(user)!.items.fiftyFifty = 1;
    expect(err(() => game.useFiftyFifty(user, round.revealAt! + 10))).toBe('There is nobody to cut this round.');
    expect(game.player(user)!.items.fiftyFifty).toBe(1);
    expect(game.state.round!.fiftyFiftyUsed[user]).toBeUndefined();

    // Two players: the same for both, owner included.
    const duo = started(['Host', 'Bea'], { rounds: 2, mediaMode: 'photos' });
    const duoRound = revealRound(duo.game);
    for (const id of duo.ids) {
      duo.game.player(id)!.items.fiftyFifty = 1;
      expect(errStatus(() => duo.game.useFiftyFifty(id, duoRound.revealAt! + 10))).toBe(409);
      expect(duo.game.player(id)!.items.fiftyFifty).toBe(1);
    }
  });

  it('refunds a charge spent on the owner’s own round, capped at two', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal'], { rounds: 1, mediaMode: 'photos' });
    const round = revealRound(game);
    const owner = round.ownerID;
    game.player(owner)!.items.fiftyFifty = 2;
    game.useFiftyFifty(owner, round.revealAt! + 10);
    expect(game.player(owner)!.items.fiftyFifty).toBe(1);
    expect(game.state.round!.eliminated[owner] ?? []).not.toContain(owner);
    finishOthers(game, round);
    expect(game.player(owner)!.items.fiftyFifty).toBe(2);
    expect(rowFor(game, owner)).toMatchObject({ fiftyFifty: true, points: 0 });
  });

  it('refuses use outside a reveal, while paused, and for a player who is not a guesser', () => {
    const { game, ids } = gameWith();
    const user = ids[0];
    // Lobby.
    expect(errStatus(() => game.useFiftyFifty(user, T0))).toBe(409);

    // Countdown.
    game.updateSettings(ids[0], { rounds: 2, mediaMode: 'photos' }, T0);
    for (const id of ids) game.setDeck(id, 12, 6, T0);
    for (const id of ids) game.setReady(id, true, T0);
    game.start(ids[0], T0);
    game.player(user)!.items.fiftyFifty = 1;
    expect(errStatus(() => game.useFiftyFifty(user, T0 + 1))).toBe(409);

    // A player who dropped before the reveal is not a guesser when it starts.
    const away = ids[2];
    game.player(away)!.items.fiftyFifty = 1;
    game.disconnect(away, T0 + 2);
    const round = revealRound(game);
    game.connect(away, round.revealAt! + 1);
    expect(err(() => game.useFiftyFifty(away, round.revealAt! + 2))).toBe("You can't use a 50/50 right now.");

    // Paused.
    game.pause(ids[0], round.revealAt! + 3);
    const guesser = round.guessers.find((id) => id !== away)!;
    game.player(guesser)!.items.fiftyFifty = 1;
    expect(err(() => game.useFiftyFifty(guesser, round.revealAt! + 4))).toBe('The game is paused.');
  });
});

describe('the shop', () => {
  it('opens in the break, sells once per player, and takes points immediately', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal'], { rounds: 3, mediaMode: 'photos', powerups: powerupsWith({ shop: { enabled: true } }) });
    const round = revealRound(game);
    guessAll(game);
    expect(game.state.phase).toBe('results');
    // The shop break is at least 12 s, even with the 7 s default.
    expect(game.state.phaseEndsAt).toBe(round.revealAt! + 100 + 12_000);
    const resultsAt = round.revealAt! + 100;

    const buyer = ids[1];
    expect(game.view(buyer, T0).shop).toEqual({ open: true, bought: false, prices: PRICES });
    expect(game.view(buyer, T0).shop!.open).toBe(true);

    game.player(buyer)!.score = 1_000;
    game.buy(buyer, 'fiftyFifty', resultsAt + 500);
    expect(game.player(buyer)!.score).toBe(600);
    expect(game.player(buyer)!.items.fiftyFifty).toBe(1);
    expect(game.view(buyer, T0).shop).toEqual({ open: true, bought: true, prices: PRICES });
    expect(game.view(ids[2], T0).shop!.bought).toBe(false);
    expect(err(() => game.buy(buyer, 'shield', resultsAt + 600))).toBe('One buy per break.');

    const other = ids[2];
    game.player(other)!.score = 1_000;
    expect(errStatus(() => game.buy(other, 'bomb', resultsAt + 700))).toBe(422);
    expect(err(() => game.buy(other, 'bomb', resultsAt + 700))).toBe('That item is not in the shop.');
    game.player(other)!.items.shield = 1;
    expect(err(() => game.buy(other, 'shield', resultsAt + 800))).toBe('You already have one.');
    game.player(other)!.items.shield = 0;
    game.player(other)!.score = 100;
    expect(err(() => game.buy(other, 'shield', resultsAt + 900))).toBe('Not enough points.');
    game.player(other)!.score = 200;
    game.buy(other, 'shield', resultsAt + 1_000);
    expect(game.player(other)!.score).toBe(0);
    expect(game.view(other, T0).shop!.bought).toBe(true);

    // Pausing the break closes the shop.
    game.pause(ids[0], resultsAt + 1_100);
    expect(game.view(other, T0).shop!.open).toBe(false);
    const late = ids[0];
    game.player(late)!.score = 1_000;
    expect(err(() => game.buy(late, 'shield', resultsAt + 1_200))).toBe('The shop is closed.');
    game.resume(ids[0], resultsAt + 2_000);

    // The next break resets the one-per-break rule and the hold limits still apply.
    leaveResults(game);
    playRound(game);
    expect(game.view(late, T0).shop).toMatchObject({ open: true, bought: false });
    game.player(late)!.items = { doubleDown: 1, shield: 1, fiftyFifty: 2 };
    game.player(late)!.score = 10_000;
    expect(err(() => game.buy(late, 'doubleDown', T0 + 2_000))).toBe('You already have one.');
    game.player(late)!.items.doubleDown = 0;
    game.buy(late, 'doubleDown', T0 + 2_100);
    expect(game.player(late)!.score).toBe(9_750);
    expect(game.player(late)!.items.doubleDown).toBe(1);

    // After the final round the shop is closed (but still reported).
    leaveResults(game);
    playRound(game);
    expect(game.state.lastResult!.index).toBe(3);
    expect(game.view(late, T0).shop).toEqual({ open: false, bought: false, prices: PRICES });
    game.player(late)!.score = 1_000;
    expect(err(() => game.buy(late, 'shield', T0 + 3_000))).toBe('The shop is closed.');
  });

  it('is closed everywhere else and absent when disabled', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 1, mediaMode: 'photos' });
    expect(game.view(ids[0], T0).shop).toBeNull();
    expect(err(() => game.buy(ids[0], 'shield', T0))).toBe('The shop is closed.');
    const round = revealRound(game);
    expect(game.view(ids[0], T0).shop).toBeNull();
    expect(err(() => game.buy(ids[0], 'shield', T0 + 1))).toBe('The shop is closed.');
    guessAll(game);
    expect(game.view(ids[0], T0).shop).toBeNull();
    expect(err(() => game.buy(ids[0], 'shield', T0 + 2))).toBe('The shop is closed.');
  });

  it('lengthens the break to max(breakSeconds, 12) only when the shop is on and will open', () => {
    const cases: [number, boolean, number][] = [
      [5, true, 12_000],
      [12, true, 12_000],
      [20, true, 20_000],
      [5, false, 5_000],
      [30, false, 30_000],
    ];
    for (const [breakSeconds, shop, expected] of cases) {
      const { game } = started(['Host', 'Bea'], {
        rounds: 2,
        breakSeconds,
        mediaMode: 'photos',
        powerups: powerupsWith({ shop: { enabled: shop } }),
      });
      const round = revealRound(game);
      guessAll(game);
      expect(game.state.phaseEndsAt, `break ${breakSeconds} shop ${shop}`).toBe(round.revealAt! + 100 + expected);
      // The final round's results never open the shop, so they keep the host's time.
      leaveResults(game);
      const last = revealRound(game);
      guessAll(game);
      expect(game.state.lastResult!.index).toBe(2);
      expect(game.state.phaseEndsAt, `final break ${breakSeconds} shop ${shop}`).toBe(last.revealAt! + 100 + breakSeconds * 1000);
    }
  });
});

describe('Double Down', () => {
  it('doubles a correct guess and is spent', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 2, mediaMode: 'photos' });
    const round = revealRound(game);
    const owner = round.ownerID;
    const guesser = ids.find((id) => id !== owner)!;
    game.player(guesser)!.items.doubleDown = 1;
    game.guess(guesser, owner, round.revealAt! + 5_000);
    game.guess(owner, owner, round.revealAt! + 5_000);
    // 500 accuracy + 375 speed, doubled.
    expect(rowFor(game, guesser)).toMatchObject({ points: 1_750, doubleDown: 'won', correct: true, total: 1_750 });
    expect(game.player(guesser)!.items.doubleDown).toBe(0);
  });

  it('loses 300 on a wrong or missing guess, never below zero', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 2, mediaMode: 'photos' });
    let round = revealRound(game);
    let owner = round.ownerID;
    let guesser = ids.find((id) => id !== owner)!;
    game.player(guesser)!.score = 100;
    game.player(guesser)!.items.doubleDown = 1;
    game.guess(guesser, guesser, round.revealAt! + 1_000); // wrong
    game.guess(owner, owner, round.revealAt! + 1_000);
    expect(rowFor(game, guesser)).toMatchObject({ points: -100, total: 0, doubleDown: 'lost', correct: false });
    expect(game.player(guesser)!.score).toBe(0);
    expect(game.player(guesser)!.items.doubleDown).toBe(0);

    leaveResults(game);
    round = revealRound(game);
    owner = round.ownerID;
    guesser = ids.find((id) => id !== owner)!;
    game.player(guesser)!.items.doubleDown = 1;
    // No guess: the timer runs out.
    finishRound(game);
    expect(rowFor(game, guesser)).toMatchObject({ points: 0, total: 0, doubleDown: 'lost' });
  });

  it('is refunded when the player turns out to be the owner, then used next round', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 2, mediaMode: 'photos' });
    const round = revealRound(game);
    const owner = round.ownerID;
    const guesser = ids.find((id) => id !== owner)!;
    game.player(owner)!.items.doubleDown = 1;
    game.guess(guesser, owner, round.revealAt! + 100);
    game.guess(owner, owner, round.revealAt! + 100);
    expect(rowFor(game, owner)).toMatchObject({ doubleDown: 'refunded', points: 0 });
    expect(game.player(owner)!.items.doubleDown).toBe(1);

    leaveResults(game);
    const next = revealRound(game);
    expect(next.ownerID).not.toBe(owner);
    game.guess(owner, next.ownerID, next.revealAt! + 5_000);
    game.guess(next.ownerID, next.ownerID, next.revealAt! + 5_000);
    expect(rowFor(game, owner)).toMatchObject({ doubleDown: 'won', points: 1_750 });
    expect(game.player(owner)!.items.doubleDown).toBe(0);
  });

  it('stays armed when the player is not a guesser at the reveal', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal'], { rounds: 2, mediaMode: 'photos' });
    const away = ids[2];
    game.player(away)!.items.doubleDown = 1;
    game.disconnect(away, T0 + 1);
    const round = revealRound(game);
    expect(round.guessers).not.toContain(away);
    finishOthers(game, round);
    expect(game.state.lastResult!.rows.some((row) => row.playerID === away)).toBe(false);
    expect(game.player(away)!.items.doubleDown).toBe(1);
  });
});

describe('Shield', () => {
  it('saves both streaks on a miss, then is spent', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 2, mediaMode: 'photos' });
    const round = revealRound(game);
    const owner = round.ownerID;
    const guesser = ids.find((id) => id !== owner)!;
    game.player(guesser)!.streak = 3;
    game.player(guesser)!.missStreak = 1;
    game.player(guesser)!.items.shield = 1;
    game.guess(guesser, guesser, round.revealAt! + 1_000); // wrong
    game.guess(owner, owner, round.revealAt! + 1_000);
    expect(rowFor(game, guesser)).toMatchObject({ shielded: true, points: 0, streak: 3 });
    expect(game.player(guesser)!.items.shield).toBe(0);
    expect(game.player(guesser)!.streak).toBe(3);
    expect(game.player(guesser)!.missStreak).toBe(1);

    // Without a shield, the next miss resets the streak and grows the miss streak.
    leaveResults(game);
    const next = revealRound(game);
    const nextOwner = next.ownerID;
    const nextGuesser = ids.find((id) => id !== nextOwner)!;
    game.player(nextGuesser)!.streak = 2;
    game.player(nextGuesser)!.missStreak = 3;
    game.guess(nextGuesser, nextGuesser, next.revealAt! + 1_000);
    game.guess(nextOwner, nextOwner, next.revealAt! + 1_000);
    expect(game.player(nextGuesser)!.streak).toBe(0);
    expect(game.player(nextGuesser)!.missStreak).toBe(4);
  });

  it('is kept by a correct guess and on the owner’s own round', () => {
    const { game, ids } = started(['Host', 'Bea'], { rounds: 2, mediaMode: 'photos' });
    const round = revealRound(game);
    const owner = round.ownerID;
    const guesser = ids.find((id) => id !== owner)!;
    game.player(owner)!.items.shield = 1;
    game.player(guesser)!.items.shield = 1;
    // The owner's decoy guess is a miss on their own round; the shield is untouched.
    game.guess(owner, guesser, round.revealAt! + 100);
    game.guess(guesser, owner, round.revealAt! + 100);
    expect(rowFor(game, owner)).toMatchObject({ shielded: false, points: 0 });
    expect(game.player(owner)!.items.shield).toBe(1);
    // A correct guess does not spend it either.
    expect(rowFor(game, guesser)).toMatchObject({ shielded: false, correct: true });
    expect(game.player(guesser)!.items.shield).toBe(1);
  });

  it('is spent by a missing guess', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal'], { rounds: 1, mediaMode: 'photos' });
    const round = revealRound(game);
    const owner = round.ownerID;
    const [armed] = ids.filter((id) => id !== owner);
    game.player(armed)!.streak = 2;
    game.player(armed)!.missStreak = 2;
    game.player(armed)!.items.shield = 1;
    // Everyone else guesses; the armed player lets the clock run out.
    for (const id of round.guessers) if (id !== armed) game.guess(id, owner, round.revealAt! + 100);
    finishRound(game);
    expect(rowFor(game, armed)).toMatchObject({ shielded: true, points: 0, streak: 2 });
    expect(game.player(armed)!.items.shield).toBe(0);
    expect(game.player(armed)!.streak).toBe(2);
    expect(game.player(armed)!.missStreak).toBe(2);
  });
});

describe('result rows and public items', () => {
  it('fills every new ResultRow field and shows held items to everyone', () => {
    const { game, ids } = started(['Host', 'Bea', 'Cal', 'Dee'], {
      rounds: 1,
      timerSeconds: 20,
      mediaMode: 'photos',
      effects: effectsWith({
        greyscale: { enabled: true, trigger: 'right', after: 2 },
        focus: { enabled: true, frequency: 'every', span: 100 },
      }),
      powerups: powerupsWith({ fiftyFifty: { enabled: true, after: 3 } }),
    });
    const slot = slotFor(game, 1);
    const owner = slot.ownerID;
    const guessers = ids.filter((id) => id !== owner);
    const guesser = guessers[0];
    game.player(guesser)!.streak = 2;
    const round = revealRound(game);
    game.player(guesser)!.items = { doubleDown: 1, shield: 1, fiftyFifty: 1 };
    game.useFiftyFifty(guesser, round.revealAt! + 10);
    game.guess(guesser, owner, round.revealAt! + 5_000);
    game.guess(guessers[1], owner, round.revealAt! + 100);
    game.guess(guessers[2], owner, round.revealAt! + 100);
    game.guess(owner, owner, round.revealAt! + 0);
    expect(game.state.phase).toBe('results');

    const row = rowFor(game, guesser);
    // base = 500 accuracy + 375 speed + 200 streak bonus, +150 sharp eyes, ×2.
    expect(row).toMatchObject({
      correct: true,
      bonus: 150,
      doubleDown: 'won',
      shielded: false,
      effect: 'greyscale',
      roundEffect: 'focus',
      fiftyFifty: true,
      earnedFiftyFifty: true,
      streak: 3,
      points: 2_450,
    });
    expect(game.player(guesser)!.items).toMatchObject({ doubleDown: 0, shield: 1, fiftyFifty: 1 });
    expect(rowFor(game, owner)).toMatchObject({ effect: null, roundEffect: 'focus', bonus: 0, fiftyFifty: false, doubleDown: null });

    // Held items are public in every viewer's state.
    for (const id of ids) {
      expect(game.view(id, T0).players.find((player) => player.id === guesser)!.items).toEqual({
        doubleDown: 0,
        shield: 1,
        fiftyFifty: 1,
      });
    }
    // The shop view is for results only and is per viewer.
    expect(game.view(ids[0], T0).shop).toBeNull();
    expect(game.view(ids[0], T0).lastResult).not.toBeNull();
  });
});

// Small local copy of the shared room builder for the two tests that need the
// lobby before a game exists (started() starts one immediately).
function gameWith(names = ['Host', 'Bea', 'Cal']) {
  const game = new Game(newRoom('ABC234', 'inst', T0));
  const players = names.map((name) => game.join({ kind: 'guest' }, name, T0));
  for (const player of players) game.connect(player.id, T0);
  return { game, ids: players.map((player) => player.id) };
}
