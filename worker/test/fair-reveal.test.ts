// Milestone 5 (docs/MILESTONE5.md): a reveal fixed ahead of time once everyone
// has the media, the countdown carrying it, late alarms, and guesses timed from
// when each player actually saw the round.
import { describe, expect, it } from 'vitest';
import { PHOTO_BUNCH, VIDEO_BUNCH } from '../src/bunch';
import { COUNTDOWN_MS, Game, GUESS_GRACE_MS, LAG_ALLOWANCE_MS, LATE_ALARM_MS, MEDIA_SETTLE_MS, MEDIA_WAIT_MAX_MS, REVEAL_LEAD_MS } from '../src/game';
import { acceptedElapsed, canFixReveal, plannedRevealAt, revealStart, waitingOn } from '../src/reveal';
import type { Settings } from '../src/settings';
import { effectsWith, err, gameWith, slotFor, T0 } from './game-helpers';

/** Like `started`, but every player said `hello` with `fairReveal` first. */
function fairStarted(names = ['Host', 'Bea', 'Cal'], patch: Partial<Record<keyof Settings, unknown>> = {}, fair = names.map(() => true)) {
  const setup = gameWith(names);
  setup.ids.forEach((id, i) => setup.game.hello(id, fair[i] ? ['fairReveal'] : []));
  setup.game.updateSettings(setup.ids[0], { rounds: 3, mediaMode: 'photos', ...patch }, T0);
  for (const id of setup.ids) setup.game.setDeck(id, PHOTO_BUNCH, VIDEO_BUNCH, T0);
  for (const id of setup.ids) setup.game.setReady(id, true, T0);
  setup.game.start(setup.ids[0], T0);
  return setup;
}

/** Uploads round 1 and has every non-owner ack it at `at`; returns the slot's owner. */
function uploadAndAck(game: Game, ids: string[], uploadAt: number, ackAt = uploadAt) {
  const slot = slotFor(game, 1);
  game.markReady(slot.ownerID, slot.id, slot.requiredKind, uploadAt);
  for (const id of ids) if (id !== slot.ownerID) game.mediaReady(id, 1, ackAt);
  return slot.ownerID;
}

describe('reveal timing rules', () => {
  it('waits only on connected, non-owner, fair players who have not acked', () => {
    const players = [
      { id: 'o', connected: true, fairReveal: true },
      { id: 'a', connected: true, fairReveal: true },
      { id: 'b', connected: false, fairReveal: true },
      { id: 'c', connected: true },
    ];
    expect(waitingOn(players, 'o', [])).toEqual(['a']);
    expect(waitingOn(players, 'o', ['a'])).toEqual([]);
    expect(canFixReveal({ now: 0, readyAt: 0, ownerID: 'o', players, loadedBy: [] })).toBe(false);
    expect(canFixReveal({ now: MEDIA_WAIT_MAX_MS, readyAt: 0, ownerID: 'o', players, loadedBy: [] })).toBe(true);
  });

  it('plans exactly the M4 time with only legacy clients, and a lead with fair ones', () => {
    const legacy = [{ id: 'o', connected: true }, { id: 'a', connected: true }];
    const fair = legacy.map((p) => ({ ...p, fairReveal: true }));
    const base = { countdownStart: 0, countdownMs: COUNTDOWN_MS, ownerID: 'o' };
    expect(plannedRevealAt({ ...base, now: 2_500, readyAt: 2_500, players: legacy })).toBe(2_500 + MEDIA_SETTLE_MS);
    expect(plannedRevealAt({ ...base, now: 100, readyAt: 100, players: legacy })).toBe(COUNTDOWN_MS);
    expect(plannedRevealAt({ ...base, now: 2_500, readyAt: 2_400, players: fair })).toBe(2_500 + REVEAL_LEAD_MS);
    expect(plannedRevealAt({ ...base, now: 100, readyAt: 100, players: fair })).toBe(COUNTDOWN_MS);
  });

  it('keeps the planned reveal for a slightly late alarm, starts now for a very late one', () => {
    expect(revealStart(10_000, 10_000)).toBe(10_000);
    expect(revealStart(10_000, 10_000 + LATE_ALARM_MS)).toBe(10_000);
    expect(revealStart(10_000, 10_000 + LATE_ALARM_MS + 1)).toBe(10_000 + LATE_ALARM_MS + 1);
  });

  it('trusts a fair client down to the lag allowance and never above the server', () => {
    expect(acceptedElapsed(1_900, 1_200, true)).toBe(1_200);
    expect(acceptedElapsed(1_900, 100, true)).toBe(1_900 - LAG_ALLOWANCE_MS);
    expect(acceptedElapsed(1_900, 5_000, true)).toBe(1_900);
    expect(acceptedElapsed(400, 0, true)).toBe(0);
    expect(acceptedElapsed(1_900, 1_200, false)).toBe(1_900);
    for (const bad of [undefined, null, -5, Number.NaN, Infinity, '1200']) expect(acceptedElapsed(1_900, bad, true)).toBe(1_900);
  });
});

describe('a fair reveal', () => {
  it('waits for every player to have the media, then fixes the time ahead and shares it', () => {
    const { game, ids } = fairStarted(['Host', 'Bea', 'Cal'], {
      effects: effectsWith({ focus: { enabled: true, frequency: 'every', span: 50 } }),
    });
    const slot = slotFor(game, 1);
    const others = ids.filter((id) => id !== slot.ownerID);
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0 + 1_000);
    // Uploaded, but nobody has acked yet: still waiting, nothing about the round leaks.
    expect(game.state.phaseEndsAt).toBeNull();
    const before = game.view(others[0], T0 + 1_000).round!;
    expect(before).toEqual({ index: 1, total: 3, waiting: true, revealAt: null });
    expect(game.nextDeadline()).toBe(T0 + 1_000 + MEDIA_WAIT_MAX_MS);

    game.mediaReady(others[0], 1, T0 + 1_500);
    game.mediaReady(others[0], 1, T0 + 1_600); // a repeat is ignored
    expect(game.state.phaseEndsAt).toBeNull();
    game.mediaReady(slot.ownerID, 1, T0 + 1_700); // the owner never holds it up
    expect(game.state.phaseEndsAt).toBeNull();

    game.mediaReady(others[1], 1, T0 + 2_900);
    const revealAt = T0 + 2_900 + REVEAL_LEAD_MS;
    expect(game.state.phaseEndsAt).toBe(revealAt);
    for (const id of ids) {
      expect(game.view(id, T0 + 2_900).round).toMatchObject({ index: 1, waiting: false, revealAt, kind: 'photo', effect: { kind: 'focus' } });
    }
    expect(game.view(slot.ownerID, T0 + 2_900).round).toMatchObject({ yourEffect: null });

    game.tick(revealAt);
    expect(game.state.phase).toBe('reveal');
    expect(game.state.round!.revealAt).toBe(revealAt);
    expect(game.state.round!.endsAt).toBe(revealAt + 20_000);
    expect(game.state.phaseEndsAt).toBe(revealAt + 20_000 + GUESS_GRACE_MS);
  });

  it('stops waiting at the cap, and for a player who drops', () => {
    const capped = fairStarted();
    const slot = slotFor(capped.game, 1);
    capped.game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0);
    capped.game.tick(T0 + MEDIA_WAIT_MAX_MS - 1);
    expect(capped.game.state.phaseEndsAt).toBeNull();
    capped.game.tick(T0 + MEDIA_WAIT_MAX_MS);
    expect(capped.game.state.phaseEndsAt).toBe(T0 + MEDIA_WAIT_MAX_MS + REVEAL_LEAD_MS);

    const dropped = fairStarted();
    const dslot = slotFor(dropped.game, 1);
    const [acker, dropper] = dropped.ids.filter((id) => id !== dslot.ownerID);
    dropped.game.markReady(dslot.ownerID, dslot.id, dslot.requiredKind, T0);
    dropped.game.mediaReady(acker, 1, T0 + 200);
    expect(dropped.game.state.phaseEndsAt).toBeNull();
    dropped.game.disconnect(dropper, T0 + 400);
    expect(dropped.game.state.phaseEndsAt).toBe(T0 + COUNTDOWN_MS);
  });

  it('never waits on legacy clients, but still gives them the settle time', () => {
    const { game, ids } = fairStarted(['Host', 'Bea', 'Cal'], {}, [true, true, false]);
    const slot = slotFor(game, 1);
    game.markReady(slot.ownerID, slot.id, slot.requiredKind, T0 + 2_500);
    for (const id of ids) if (id !== slot.ownerID) game.mediaReady(id, 1, T0 + 2_500);
    const legacyIsOther = slot.ownerID !== ids[2];
    expect(game.state.phaseEndsAt).toBe(legacyIsOther ? T0 + 2_500 + MEDIA_SETTLE_MS : T0 + 2_500 + REVEAL_LEAD_MS);
  });

  it('fixes the next round at once when its media arrived and was acked during this one', () => {
    const { game, ids } = fairStarted();
    uploadAndAck(game, ids, T0);
    game.tick(game.state.phaseEndsAt!);
    const next = slotFor(game, 2);
    game.markReady(next.ownerID, next.id, next.requiredKind, game.state.round!.revealAt! + 500);
    for (const id of ids) game.mediaReady(id, 2, game.state.round!.revealAt! + 900);
    const endsAt = game.state.round!.endsAt!;
    game.tick(game.state.phaseEndsAt!); // timer ran out
    expect(game.state.phase).toBe('results');
    const resultsEnd = game.state.phaseEndsAt!;
    game.tick(resultsEnd);
    expect(game.state.phase).toBe('countdown');
    expect(game.state.phaseEndsAt).toBe(resultsEnd + COUNTDOWN_MS);
    expect(game.view(ids[0], resultsEnd).round).toMatchObject({ index: 2, waiting: false, revealAt: resultsEnd + COUNTDOWN_MS });
    expect(endsAt).toBeLessThan(resultsEnd);
  });

  it('keeps the planned start for a slightly late alarm and restarts the clock for a very late one', () => {
    const onTime = fairStarted();
    uploadAndAck(onTime.game, onTime.ids, T0);
    const due = onTime.game.state.phaseEndsAt!;
    onTime.game.tick(due + 400);
    expect(onTime.game.state.round!.revealAt).toBe(due);

    const late = fairStarted();
    uploadAndAck(late.game, late.ids, T0);
    const lateDue = late.game.state.phaseEndsAt!;
    late.game.tick(lateDue + 60_000);
    expect(late.game.state.round!.revealAt).toBe(lateDue + 60_000);
    expect(late.game.state.round!.endsAt).toBe(lateDue + 60_000 + 20_000);
  });

  it('hides the planned time while a fixed countdown is paused, and brings it back on resume', () => {
    const { game, ids } = fairStarted();
    uploadAndAck(game, ids, T0);
    game.pause(ids[0], T0 + 1_000);
    expect(game.view(ids[1], T0 + 1_000).round).toMatchObject({ waiting: false, revealAt: null });
    game.resume(ids[0], T0 + 30_000);
    const resumed = game.state.phaseEndsAt!;
    expect(resumed).toBe(T0 + 30_000 + 2_000);
    expect(game.view(ids[1], T0 + 30_000).round).toMatchObject({ revealAt: resumed });
  });
});

describe('fair guess timing', () => {
  it('scores a guess from when the player saw it, within the lag allowance', () => {
    const { game, ids } = fairStarted(['Host', 'Bea', 'Cal', 'Dee'], {}, [true, true, true, false]);
    const owner = uploadAndAck(game, ids, T0);
    game.tick(game.state.phaseEndsAt!);
    const round = game.state.round!;
    const [a, b, c] = ids.filter((id) => id !== owner);
    game.guess(a, owner, round.revealAt! + 1_900, 1_200);
    game.guess(b, owner, round.revealAt! + 1_900, 100);
    game.guess(c, owner, round.revealAt! + 1_900, 50);
    const elapsed = (id: string) => round.guesses[id].elapsedMs;
    expect(elapsed(a)).toBe(1_200);
    expect(elapsed(b)).toBe(1_900 - LAG_ALLOWANCE_MS);
    // Dee never said hello (index 3 is legacy unless it's the owner): timed on arrival.
    if (c === ids[3]) expect(elapsed(c)).toBe(1_900);
  });

  it('lets an in-flight guess land just after time-up, but not a late one', () => {
    const { game, ids } = fairStarted(['Host', 'Bea', 'Cal', 'Dee'], {}, [true, true, true, false]);
    const owner = uploadAndAck(game, ids, T0);
    game.tick(game.state.phaseEndsAt!);
    const round = game.state.round!;
    const timer = round.endsAt! - round.revealAt!;
    const fair = ids.filter((id) => id !== owner && id !== ids[3]);
    // Sent 200 ms before time-up, arrives 300 ms after.
    game.guess(fair[0], owner, round.endsAt! + 300, timer - 200);
    expect(round.guesses[fair[0]].elapsedMs).toBe(timer - 200);
    // Past the grace window: refused whatever the client says.
    expect(err(() => game.guess(fair[1], owner, round.endsAt! + GUESS_GRACE_MS + 1, timer - 200))).toBe('Time is up.');
    // A legacy client inside the grace window is still past its timer.
    if (ids[3] !== owner) expect(err(() => game.guess(ids[3], owner, round.endsAt! + 300))).toBe('Time is up.');
  });
});
