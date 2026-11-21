// Room settings: the lobby's knobs, their defaults, validation for the
// `settings` message, and normalization for rooms persisted by an older build.
// docs/MILESTONE4.md §1.
import { defaultEffects, normalizeEffects, validateEffects, type EffectsSettings } from './effects';
import { GameError } from './errors';
import type { MediaMode } from './media';
import { defaultPowerups, normalizePowerups, validatePowerups, type PowerupsSettings } from './shop';

export const ROUNDS = { min: 1, max: 100, default: 10 } as const;
export const TIMER_SECONDS = { min: 10, max: 60, default: 20 } as const;
export const BREAK_SECONDS = { min: 3, max: 30, default: 7 } as const;
export const SWAPS = { min: 0, max: 10, default: 3 } as const;
export const MEDIA_MODES: readonly MediaMode[] = ['photos', 'videos', 'both'];

export interface Settings {
  rounds: number;
  timerSeconds: number;
  mediaMode: MediaMode;
  /** How long the results screen lasts between rounds. */
  breakSeconds: number;
  /** How many times a player may swap a tile in their bunch (clients only). */
  swaps: number;
  /** Everyone deals exactly their share of the rounds (§2). */
  evenSplit: boolean;
  effects: EffectsSettings;
  powerups: PowerupsSettings;
}

export const defaultSettings = (): Settings => ({
  rounds: ROUNDS.default,
  timerSeconds: TIMER_SECONDS.default,
  mediaMode: 'both',
  breakSeconds: BREAK_SECONDS.default,
  swaps: SWAPS.default,
  evenSplit: false,
  effects: defaultEffects(),
  powerups: defaultPowerups(),
});

const intIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

/** Fills anything missing or out of range, so every reader sees the full settings shape. */
export function normalizeSettings(raw: unknown): Settings {
  const settings = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const defaults = defaultSettings();
  return {
    rounds: intIn(settings.rounds, ROUNDS) ? settings.rounds : defaults.rounds,
    timerSeconds: intIn(settings.timerSeconds, TIMER_SECONDS) ? settings.timerSeconds : defaults.timerSeconds,
    mediaMode: MEDIA_MODES.includes(settings.mediaMode as MediaMode) ? (settings.mediaMode as MediaMode) : defaults.mediaMode,
    breakSeconds: intIn(settings.breakSeconds, BREAK_SECONDS) ? settings.breakSeconds : defaults.breakSeconds,
    swaps: intIn(settings.swaps, SWAPS) ? settings.swaps : defaults.swaps,
    evenSplit: typeof settings.evenSplit === 'boolean' ? settings.evenSplit : defaults.evenSplit,
    effects: normalizeEffects(settings.effects),
    powerups: normalizePowerups(settings.powerups),
  };
}

/**
 * Applies a `settings` message patch. Absent keys are left alone; `effects`
 * and `powerups` arrive whole and replace their group. Throws GameError(422)
 * with a short message for anything invalid.
 */
export function applySettingsPatch(current: Settings, patch: Partial<Record<keyof Settings, unknown>>): Settings {
  const next = { ...current };
  if (patch.rounds !== undefined) {
    if (!intIn(patch.rounds, ROUNDS)) throw new GameError(422, `Rounds must be ${ROUNDS.min}–${ROUNDS.max}.`);
    next.rounds = patch.rounds;
  }
  if (patch.timerSeconds !== undefined) {
    if (!intIn(patch.timerSeconds, TIMER_SECONDS))
      throw new GameError(422, `The timer must be ${TIMER_SECONDS.min}–${TIMER_SECONDS.max} seconds.`);
    next.timerSeconds = patch.timerSeconds;
  }
  if (patch.mediaMode !== undefined) {
    if (!MEDIA_MODES.includes(patch.mediaMode as MediaMode)) throw new GameError(422, 'Choose Photos, Videos, or Both.');
    next.mediaMode = patch.mediaMode as MediaMode;
  }
  if (patch.breakSeconds !== undefined) {
    if (!intIn(patch.breakSeconds, BREAK_SECONDS)) throw new GameError(422, `Break must be ${BREAK_SECONDS.min}–${BREAK_SECONDS.max} seconds.`);
    next.breakSeconds = patch.breakSeconds;
  }
  if (patch.swaps !== undefined) {
    if (!intIn(patch.swaps, SWAPS)) throw new GameError(422, `Swaps must be ${SWAPS.min}–${SWAPS.max}.`);
    next.swaps = patch.swaps;
  }
  if (patch.evenSplit !== undefined) {
    if (typeof patch.evenSplit !== 'boolean') throw new GameError(422, 'Even Split must be on or off.');
    next.evenSplit = patch.evenSplit;
  }
  if (patch.effects !== undefined) next.effects = validateEffects(patch.effects);
  if (patch.powerups !== undefined) next.powerups = validatePowerups(patch.powerups);
  return next;
}
