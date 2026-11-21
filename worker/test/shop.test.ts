import { describe, expect, it } from 'vitest';
import { GameError } from '../src/errors';
import {
  DOUBLE_DOWN_PENALTY,
  HOLD_LIMITS,
  SHOP_MIN_BREAK_SECONDS,
  SHOP_PRICES,
  buyItem,
  defaultPowerups,
  emptyItems,
  normalizeItems,
  normalizePowerups,
  resultsBreakSeconds,
  shopOpenFor,
  validatePowerups,
  type Items,
} from '../src/shop';

function caught(fn: () => unknown): GameError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return e as GameError;
  }
  throw new Error('expected a GameError');
}

const wallet = (score: number, items: Partial<Items> = {}) => ({ score, items: { ...emptyItems(), ...items } });

describe('the shop catalogue', () => {
  it('has the contract prices and limits', () => {
    expect(SHOP_PRICES).toEqual({ doubleDown: 250, shield: 200, fiftyFifty: 400 });
    expect(HOLD_LIMITS).toEqual({ doubleDown: 1, shield: 1, fiftyFifty: 2 });
    expect(DOUBLE_DOWN_PENALTY).toBe(300);
    expect(SHOP_MIN_BREAK_SECONDS).toBe(12);
  });

  it('normalizes held items', () => {
    expect(normalizeItems(undefined)).toEqual({ doubleDown: 0, shield: 0, fiftyFifty: 0 });
    expect(normalizeItems({ doubleDown: 1, shield: 1, fiftyFifty: 2 })).toEqual({ doubleDown: 1, shield: 1, fiftyFifty: 2 });
    // Junk and out-of-range counts fall back to zero.
    expect(normalizeItems({ doubleDown: 2, shield: -1, fiftyFifty: 3 })).toEqual({ doubleDown: 0, shield: 0, fiftyFifty: 0 });
    expect(normalizeItems({ doubleDown: 0.5, shield: '1', fiftyFifty: null })).toEqual({ doubleDown: 0, shield: 0, fiftyFifty: 0 });
  });
});

describe('buying', () => {
  it('takes the price at once and adds one item', () => {
    const player = wallet(1_000);
    expect(buyItem(player, 'doubleDown')).toBe('doubleDown');
    expect(player).toEqual({ score: 750, items: { doubleDown: 1, shield: 0, fiftyFifty: 0 } });
    expect(buyItem(player, 'shield')).toBe('shield');
    expect(player.score).toBe(550);
    expect(buyItem(player, 'fiftyFifty')).toBe('fiftyFifty');
    expect(player.score).toBe(150);
    expect(player.items.fiftyFifty).toBe(1);
  });

  it('allows a second 50/50 but not a second Double Down or Shield', () => {
    const player = wallet(2_000, { fiftyFifty: 1 });
    expect(buyItem(player, 'fiftyFifty')).toBe('fiftyFifty');
    expect(player.items.fiftyFifty).toBe(2);

    const doubleDown = wallet(2_000, { doubleDown: 1 });
    const e1 = caught(() => buyItem(doubleDown, 'doubleDown'));
    expect(e1.status).toBe(409);
    expect(e1.message).toBe('You already have one.');

    const shield = wallet(2_000, { shield: 1 });
    expect(caught(() => buyItem(shield, 'shield')).message).toBe('You already have one.');

    const fullFifty = wallet(2_000, { fiftyFifty: 2 });
    expect(caught(() => buyItem(fullFifty, 'fiftyFifty')).message).toBe('You already have one.');
    // Nothing was taken.
    expect(fullFifty.score).toBe(2_000);
  });

  it('refuses what the player cannot afford, leaving the wallet untouched', () => {
    for (const [item, price] of Object.entries(SHOP_PRICES) as [keyof typeof SHOP_PRICES, number][]) {
      const player = wallet(price - 1);
      const e = caught(() => buyItem(player, item));
      expect(e.status).toBe(422);
      expect(e.message).toBe('Not enough points.');
      expect(player.score).toBe(price - 1);
      expect(player.items).toEqual(emptyItems());
    }
    // Exactly enough is allowed.
    const exact = wallet(SHOP_PRICES.shield);
    buyItem(exact, 'shield');
    expect(exact.score).toBe(0);
  });

  it('rejects anything that is not an item', () => {
    for (const item of [undefined, null, 'bomb', '', 3, {}, []]) {
      const player = wallet(1_000);
      const e = caught(() => buyItem(player, item));
      expect(e.status).toBe(422);
      expect(e.message).toBe('That item is not in the shop.');
      expect(player.score).toBe(1_000);
    }
  });
});

describe('power-up settings', () => {
  it('has the M4 defaults', () => {
    expect(defaultPowerups()).toEqual({ fiftyFifty: { enabled: false, after: 3 }, shop: { enabled: false } });
  });

  it('normalizes old and partial records', () => {
    expect(normalizePowerups(undefined)).toEqual(defaultPowerups());
    expect(normalizePowerups({ fiftyFifty: { enabled: true, after: 6 } })).toEqual({
      fiftyFifty: { enabled: true, after: 6 },
      shop: { enabled: false },
    });
    expect(normalizePowerups({ fiftyFifty: { enabled: 'yes', after: 1 }, shop: { enabled: 'no' } })).toEqual(defaultPowerups());
    expect(normalizePowerups({ fiftyFifty: { after: 10 } })).toEqual({ fiftyFifty: { enabled: false, after: 10 }, shop: { enabled: false } });
  });

  it('validates a whole power-ups group', () => {
    expect(validatePowerups({ fiftyFifty: { enabled: true, after: 2 }, shop: { enabled: true } })).toEqual({
      fiftyFifty: { enabled: true, after: 2 },
      shop: { enabled: true },
    });
    for (const after of [1, 11, 2.5, '3', null]) {
      expect(caught(() => validatePowerups({ fiftyFifty: { enabled: true, after }, shop: { enabled: true } })).status).toBe(422);
    }
    expect(caught(() => validatePowerups({ shop: { enabled: true } })).status).toBe(422);
    expect(caught(() => validatePowerups({ fiftyFifty: { enabled: true, after: 3 } })).status).toBe(422);
    expect(caught(() => validatePowerups('nope')).status).toBe(422);
  });
});

describe('shop timing', () => {
  const open = (patch: Partial<Parameters<typeof shopOpenFor>[0]> = {}) =>
    shopOpenFor({ shopEnabled: true, phase: 'results', paused: false, lastResultIndex: 2, totalRounds: 5, ...patch });

  it('opens between rounds only', () => {
    expect(open()).toBe(true);
    expect(open({ lastResultIndex: 1 })).toBe(true);
    expect(open({ lastResultIndex: 4, totalRounds: 5 })).toBe(true);
  });

  it('is closed when disabled, out of results, paused, or after the final round', () => {
    expect(open({ shopEnabled: false })).toBe(false);
    for (const phase of ['lobby', 'countdown', 'reveal', 'podium', 'closed']) expect(open({ phase }), phase).toBe(false);
    expect(open({ paused: true })).toBe(false);
    expect(open({ lastResultIndex: 5, totalRounds: 5 })).toBe(false);
    expect(open({ lastResultIndex: null })).toBe(false);
    expect(open({ totalRounds: 0 })).toBe(false);
  });

  it('makes the break long enough to shop', () => {
    const settings = (breakSeconds: number, shop: boolean) => ({ breakSeconds, powerups: { ...defaultPowerups(), shop: { enabled: shop } } });
    expect(resultsBreakSeconds(settings(7, true))).toBe(12);
    expect(resultsBreakSeconds(settings(3, true))).toBe(12);
    expect(resultsBreakSeconds(settings(12, true))).toBe(12);
    expect(resultsBreakSeconds(settings(20, true))).toBe(20);
    expect(resultsBreakSeconds(settings(7, false))).toBe(7);
    expect(resultsBreakSeconds(settings(3, false))).toBe(3);
    expect(resultsBreakSeconds(settings(7, true), true)).toBe(7);
    expect(resultsBreakSeconds(settings(20, true), true)).toBe(20);
  });
});
