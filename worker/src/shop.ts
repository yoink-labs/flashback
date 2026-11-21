// Power-ups: the between-rounds shop, its items, and the 50/50's hold rules.
// docs/MILESTONE4.md §5–6.
//
// The shop's timing (which phase may buy, one buy per break) belongs to the
// game; this module owns the catalogue, validation and the player's wallet.
import { GameError } from './errors';

export type ShopItem = 'doubleDown' | 'shield' | 'fiftyFifty';
export const SHOP_ITEMS: readonly ShopItem[] = ['doubleDown', 'shield', 'fiftyFifty'];
export const SHOP_PRICES: Record<ShopItem, number> = { doubleDown: 250, shield: 200, fiftyFifty: 400 };
export const SHOP_MIN_BREAK_SECONDS = 12;
/** Double Down's cost for a wrong or missing guess. */
export const DOUBLE_DOWN_PENALTY = 300;
export const MAX_FIFTY_FIFTY = 2;
export const HOLD_LIMITS: Record<ShopItem, number> = { doubleDown: 1, shield: 1, fiftyFifty: MAX_FIFTY_FIFTY };

/** A player's held power-ups. Counts, never booleans, so 50/50 can stack to 2. */
export interface Items {
  doubleDown: number;
  shield: number;
  fiftyFifty: number;
}

export const emptyItems = (): Items => ({ doubleDown: 0, shield: 0, fiftyFifty: 0 });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const isShopItem = (value: unknown): value is ShopItem => typeof value === 'string' && (SHOP_ITEMS as readonly string[]).includes(value);

const heldInRange = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= limit;

/** Old rooms have no items; junk counts clamp to nothing held. */
export function normalizeItems(raw: unknown): Items {
  if (!isRecord(raw)) return emptyItems();
  return {
    doubleDown: heldInRange(raw.doubleDown, HOLD_LIMITS.doubleDown) ? raw.doubleDown : 0,
    shield: heldInRange(raw.shield, HOLD_LIMITS.shield) ? raw.shield : 0,
    fiftyFifty: heldInRange(raw.fiftyFifty, HOLD_LIMITS.fiftyFifty) ? raw.fiftyFifty : 0,
  };
}

/**
 * Validates and applies a purchase to a player. The caller has already checked
 * the shop is open and this player has not bought this break. Mutates `score`
 * and `items` only after every check passes.
 */
export function buyItem(player: { score: number; items: Items }, item: unknown): ShopItem {
  if (!isShopItem(item)) throw new GameError(422, 'That item is not in the shop.');
  if (player.items[item] >= HOLD_LIMITS[item]) throw new GameError(409, 'You already have one.');
  const price = SHOP_PRICES[item];
  if (player.score < price) throw new GameError(422, 'Not enough points.');
  player.score -= price;
  player.items[item] += 1;
  return item;
}

// ---- power-up settings ----

export interface FiftyFiftySetting {
  enabled: boolean;
  after: number;
}

export interface ShopSetting {
  enabled: boolean;
}

export interface PowerupsSettings {
  fiftyFifty: FiftyFiftySetting;
  shop: ShopSetting;
}

/** How many in a row earns a 50/50. */
export const FIFTY_FIFTY_AFTER = { min: 2, max: 10 } as const;

export const defaultPowerups = (): PowerupsSettings => ({
  fiftyFifty: { enabled: false, after: 3 },
  shop: { enabled: false },
});

const intIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

export function validatePowerups(value: unknown): PowerupsSettings {
  if (!isRecord(value) || !isRecord(value.fiftyFifty) || !isRecord(value.shop))
    throw new GameError(422, 'Power-ups need fifty/fifty and shop settings.');
  const fiftyFifty = value.fiftyFifty;
  if (typeof fiftyFifty.enabled !== 'boolean') throw new GameError(422, '50/50 must be on or off.');
  if (!intIn(fiftyFifty.after, FIFTY_FIFTY_AFTER))
    throw new GameError(422, `50/50 has to start after ${FIFTY_FIFTY_AFTER.min}–${FIFTY_FIFTY_AFTER.max}.`);
  if (typeof value.shop.enabled !== 'boolean') throw new GameError(422, 'The shop must be on or off.');
  return { fiftyFifty: { enabled: fiftyFifty.enabled, after: fiftyFifty.after }, shop: { enabled: value.shop.enabled } };
}

export function normalizePowerups(raw: unknown): PowerupsSettings {
  const source = isRecord(raw) ? raw : {};
  const fiftyFifty = isRecord(source.fiftyFifty) ? source.fiftyFifty : {};
  const shop = isRecord(source.shop) ? source.shop : {};
  return {
    fiftyFifty: {
      enabled: typeof fiftyFifty.enabled === 'boolean' ? fiftyFifty.enabled : false,
      after: intIn(fiftyFifty.after, FIFTY_FIFTY_AFTER) ? fiftyFifty.after : 3,
    },
    shop: { enabled: typeof shop.enabled === 'boolean' ? shop.enabled : false },
  };
}

// ---- shop timing ----

/**
 * The shop is open on the results screen between rounds, never on the last
 * round's results, and never while paused (the host can freeze the break).
 */
export function shopOpenFor(input: {
  shopEnabled: boolean;
  phase: string;
  paused: boolean;
  lastResultIndex: number | null;
  totalRounds: number;
}): boolean {
  if (!input.shopEnabled || input.phase !== 'results' || input.paused) return false;
  const index = input.lastResultIndex ?? 0;
  return index > 0 && index < input.totalRounds;
}

/**
 * The break long enough to shop: only when the shop is enabled and will open,
 * so the final round's results (shop closed) keep the host's break time.
 */
export function resultsBreakSeconds(settings: { breakSeconds: number; powerups: PowerupsSettings }, finalRound = false): number {
  return settings.powerups.shop.enabled && !finalRound ? Math.max(settings.breakSeconds, SHOP_MIN_BREAK_SECONDS) : settings.breakSeconds;
}
