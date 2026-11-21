// Shared helpers for the Milestone 4 game-level tests (arcade.test.ts and
// arcade-shop.test.ts). Not a test file itself.
import { expect } from 'vitest';
import { PHOTO_BUNCH, VIDEO_BUNCH } from '../src/bunch';
import { defaultEffects, type EffectsSettings } from '../src/effects';
import { Game, GameError, newRoom, type RoundState } from '../src/game';
import type { Settings } from '../src/settings';
import { sequenceRandom } from './helpers';

export const T0 = 1_000_000;

export function gameWith(names = ['Host', 'Bea', 'Cal'], random = sequenceRandom()) {
  const game = new Game(newRoom('ABC234', 'inst', T0), random);
  const players = names.map((name) => game.join({ kind: 'guest' }, name, T0));
  for (const player of players) game.connect(player.id, T0);
  return { game, players, ids: players.map((player) => player.id) };
}

export function effectsWith(patch: {
  greyscale?: Partial<EffectsSettings['greyscale']>;
  blur?: Partial<EffectsSettings['blur']>;
  focus?: Partial<EffectsSettings['focus']>;
  zoom?: Partial<EffectsSettings['zoom']>;
}): EffectsSettings {
  const base = defaultEffects();
  return {
    greyscale: { ...base.greyscale, ...patch.greyscale },
    blur: { ...base.blur, ...patch.blur },
    focus: { ...base.focus, ...patch.focus },
    zoom: { ...base.zoom, ...patch.zoom },
  };
}

/** A room with settings applied, everyone dealt a fitting bunch and ready, then started. */
export function started(
  names: string[],
  patch: Partial<Record<keyof Settings, unknown>> = {},
  decks = { photos: PHOTO_BUNCH, videos: VIDEO_BUNCH },
  random = sequenceRandom(),
) {
  const setup = gameWith(names, random);
  if (Object.keys(patch).length) setup.game.updateSettings(setup.ids[0], patch, T0);
  for (const id of setup.ids) setup.game.setDeck(id, decks.photos, decks.videos, T0);
  for (const id of setup.ids) setup.game.setReady(id, true, T0);
  setup.game.start(setup.ids[0], T0);
  return setup;
}

export const slotFor = (game: Game, round: number) => game.state.slots.find((slot) => slot.round === round)!;

export function err(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return (e as GameError).message;
  }
  throw new Error('expected a GameError');
}

export function errStatus(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return (e as GameError).status;
  }
  throw new Error('expected a GameError');
}

/** Uploads the round's item if needed, then lets the countdown finish. */
export function revealRound(game: Game): RoundState {
  expect(game.state.phase).toBe('countdown');
  const round = game.state.round!;
  const slot = slotFor(game, round.index);
  if (slot.status === 'requested') game.markReady(slot.ownerID, slot.id, slot.requiredKind, round.countdownStart);
  game.tick(game.state.phaseEndsAt!);
  expect(game.state.phase).toBe('reveal');
  return game.state.round!;
}

export function finishRound(game: Game) {
  if (game.state.phase === 'reveal') game.tick(game.state.round!.endsAt!);
  expect(game.state.phase).toBe('results');
  return game.state.lastResult!;
}

export function leaveResults(game: Game) {
  expect(game.state.phase).toBe('results');
  game.tick(game.state.phaseEndsAt!);
}

/** Everyone guesses the owner (including the owner's decoy), ending the round. */
export function guessAll(game: Game, at = 100) {
  const round = game.state.round!;
  for (const id of [...round.guessers]) {
    if (game.state.phase !== 'reveal') return;
    if (!round.guesses[id]) game.guess(id, round.ownerID, round.revealAt! + at);
  }
}

export function playRound(game: Game, at = 100) {
  revealRound(game);
  guessAll(game, at);
  return finishRound(game);
}
