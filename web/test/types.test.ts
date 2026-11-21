// Protocol defaults and normalizers (src/types.ts). Run with `npm test --prefix web`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_EFFECTS,
  DEFAULT_POWERUPS,
  DEFAULT_PRICES,
  bunchForMode,
  normalizeBunch,
  normalizeItems,
  normalizeSettings,
  normalizeShop,
  normalizeView,
  type RoomView,
} from '../src/types.ts';

test('an M3 server decodes as M4 defaults', () => {
  const settings = normalizeSettings({ rounds: 12, timerSeconds: 25, mediaMode: 'photos', breakSeconds: 7, swaps: 2 });
  assert.equal(settings.rounds, 12);
  assert.equal(settings.timerSeconds, 25);
  assert.equal(settings.mediaMode, 'photos');
  assert.equal(settings.evenSplit, false);
  assert.deepEqual(settings.effects, DEFAULT_EFFECTS);
  assert.deepEqual(settings.powerups, DEFAULT_POWERUPS);
});

test('missing settings are the contract defaults', () => {
  const settings = normalizeSettings(undefined);
  assert.equal(settings.rounds, 10);
  assert.equal(settings.timerSeconds, 20);
  assert.equal(settings.mediaMode, 'both');
  assert.equal(settings.breakSeconds, 7);
  assert.equal(settings.swaps, 3);
});

test('rounds now reach 100 and every range is clamped', () => {
  assert.equal(normalizeSettings({ rounds: 100 }).rounds, 100);
  assert.equal(normalizeSettings({ rounds: 101 }).rounds, 100);
  assert.equal(normalizeSettings({ rounds: 0 }).rounds, 1);
  assert.equal(normalizeSettings({ timerSeconds: 3 }).timerSeconds, 10);
  assert.equal(normalizeSettings({ swaps: 99 }).swaps, 10);
});

test('effects are decoded field by field, bad values falling back', () => {
  const effects = normalizeSettings({
    effects: {
      greyscale: { enabled: true, trigger: 'wrong', after: 99 },
      blur: { enabled: true, trigger: 'sideways', after: 1, strength: 'huge' },
      focus: { enabled: true, frequency: 'half', span: 75 },
      zoom: { enabled: true, frequency: 'nope', span: 33, scale: 9 },
    },
  }).effects;
  assert.deepEqual(effects.greyscale, { enabled: true, trigger: 'wrong', after: 10 });
  assert.deepEqual(effects.blur, { enabled: true, trigger: 'right', after: 2, strength: 'medium' });
  assert.deepEqual(effects.focus, { enabled: true, frequency: 'half', span: 75 });
  assert.deepEqual(effects.zoom, { enabled: true, frequency: 'every', span: 50, scale: 4 });
});

test('power-ups decode with their own defaults', () => {
  assert.deepEqual(normalizeSettings({ powerups: { fiftyFifty: { enabled: true, after: 7 } } }).powerups, {
    fiftyFifty: { enabled: true, after: 7 },
    shop: { enabled: false },
  });
  assert.deepEqual(normalizeSettings({ powerups: { shop: { enabled: true } } }).powerups, {
    fiftyFifty: { enabled: false, after: 3 },
    shop: { enabled: true },
  });
});

test('old servers size bunches from the mode; new ones send the requirement', () => {
  assert.deepEqual(normalizeBunch(undefined, 'photos'), { photos: 12, videos: 0 });
  assert.deepEqual(normalizeBunch(undefined, 'videos'), { photos: 0, videos: 6 });
  assert.deepEqual(normalizeBunch(undefined, 'both'), { photos: 12, videos: 6 });
  assert.deepEqual(bunchForMode('both'), { photos: 12, videos: 6 });
  assert.deepEqual(normalizeBunch({ photos: 2, videos: 0 }, 'both'), { photos: 2, videos: 0 });
  assert.deepEqual(normalizeBunch({ photos: -4, videos: 1000 }, 'both'), { photos: 0, videos: 100 });
});

test('the view fills in items, round effects, eliminated picks, shop and bunch', () => {
  const raw = {
    code: 'ABC234',
    phase: 'reveal',
    game: 1,
    hostID: 'p1',
    capacity: 12,
    settings: { rounds: 10, timerSeconds: 20, mediaMode: 'both' },
    serverNow: 1,
    phaseEndsAt: 2,
    paused: false,
    pausedRemainingMs: null,
    startBlocker: null,
    players: [{ id: 'p1', nickname: 'Sam', signedIn: false, isHost: true, ready: false, connected: true, score: 0, streak: 0 }],
    you: { id: 'p1' },
    round: { index: 1, total: 10, revealAt: 1, endsAt: 2 },
    lastResult: null,
    podium: [],
  } as unknown as RoomView;
  const view = normalizeView(raw);
  assert.deepEqual(view.players[0].items, { doubleDown: 0, shield: 0, fiftyFifty: 0 });
  assert.equal(view.round?.yourEffect, null);
  assert.equal(view.round?.effect, null);
  assert.deepEqual(view.round?.eliminated, []);
  assert.equal(view.shop, null);
  assert.deepEqual(view.bunch, { photos: 12, videos: 6 });
});

test('items and shop decode with ranges and default prices', () => {
  assert.deepEqual(normalizeItems({ doubleDown: 1, shield: 2, fiftyFifty: 9 }), { doubleDown: 1, shield: 1, fiftyFifty: 2 });
  assert.deepEqual(normalizeItems(undefined), { doubleDown: 0, shield: 0, fiftyFifty: 0 });
  const shop = normalizeShop({ open: true, bought: false, prices: { shield: 50 } });
  assert.deepEqual(shop, { open: true, bought: false, prices: { doubleDown: DEFAULT_PRICES.doubleDown, shield: 50, fiftyFifty: DEFAULT_PRICES.fiftyFifty } });
  assert.equal(normalizeShop(undefined), null);
});
