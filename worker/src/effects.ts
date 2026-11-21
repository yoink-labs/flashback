// Streak effects (greyscale, blur) and round effects (focus, zoom-out), plus
// the sharp-eyes bonus. docs/MILESTONE4.md §3–4.
//
// Everything here is pure: settings and counters (or randomness) go in, what a
// client should render comes out. The game decides when to call these; nothing
// in this module knows about rooms, players or sockets.
import { GameError } from './errors';
import type { FloatSource } from './random';

export type EffectTrigger = 'right' | 'wrong';
export type BlurStrength = 'light' | 'medium' | 'heavy';
export type EffectFrequency = 'every' | 'half';

export const EFFECT_TRIGGERS: readonly EffectTrigger[] = ['right', 'wrong'];
export const EFFECT_FREQUENCIES: readonly EffectFrequency[] = ['every', 'half'];
export const BLUR_STRENGTHS: readonly BlurStrength[] = ['light', 'medium', 'heavy'];
export const EFFECT_SPANS = [25, 50, 75, 100] as const;
export type EffectSpan = (typeof EFFECT_SPANS)[number];
export const ZOOM_SCALES = [2, 3, 4] as const;
export type ZoomScale = (typeof ZOOM_SCALES)[number];
/** How many in a row an effect needs before it starts. */
export const EFFECT_AFTER = { min: 2, max: 10 } as const;

export interface GreyscaleSetting {
  enabled: boolean;
  trigger: EffectTrigger;
  after: number;
}

export interface BlurSetting {
  enabled: boolean;
  trigger: EffectTrigger;
  after: number;
  strength: BlurStrength;
}

export interface FocusSetting {
  enabled: boolean;
  frequency: EffectFrequency;
  span: EffectSpan;
}

export interface ZoomSetting {
  enabled: boolean;
  frequency: EffectFrequency;
  span: EffectSpan;
  scale: ZoomScale;
}

export interface EffectsSettings {
  greyscale: GreyscaleSetting;
  blur: BlurSetting;
  focus: FocusSetting;
  zoom: ZoomSetting;
}

export const defaultEffects = (): EffectsSettings => ({
  greyscale: { enabled: false, trigger: 'right', after: 3 },
  blur: { enabled: false, trigger: 'right', after: 5, strength: 'medium' },
  focus: { enabled: false, frequency: 'every', span: 50 },
  zoom: { enabled: false, frequency: 'every', span: 50, scale: 4 },
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const intIn = (value: unknown, range: { min: number; max: number }): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;

const oneOf = <T extends string | number>(value: unknown, allowed: readonly T[]): value is T =>
  allowed.includes(value as T);

// ---- validation (the `settings` message sends effects whole) ----

export function validateEffects(value: unknown): EffectsSettings {
  if (!isRecord(value) || !isRecord(value.greyscale) || !isRecord(value.blur) || !isRecord(value.focus) || !isRecord(value.zoom))
    throw new GameError(422, 'Effects need greyscale, blur, focus, and zoom.');
  const effects: EffectsSettings = {
    greyscale: validateGreyscale(value.greyscale),
    blur: validateBlur(value.blur),
    focus: validateFocus(value.focus),
    zoom: validateZoom(value.zoom),
  };
  if (blurStartsTooEarly(effects)) throw new GameError(422, 'Blur has to start after greyscale.');
  return effects;
}

function enabledField(record: Record<string, unknown>, label: string): boolean {
  if (typeof record.enabled !== 'boolean') throw new GameError(422, `${label} must be on or off.`);
  return record.enabled;
}

function triggerField(record: Record<string, unknown>, label: string): EffectTrigger {
  if (!oneOf(record.trigger, EFFECT_TRIGGERS)) throw new GameError(422, `${label} has to follow a right or wrong streak.`);
  return record.trigger;
}

function afterField(record: Record<string, unknown>, label: string): number {
  if (!intIn(record.after, EFFECT_AFTER)) throw new GameError(422, `${label} has to start after ${EFFECT_AFTER.min}–${EFFECT_AFTER.max}.`);
  return record.after;
}

function frequencyField(record: Record<string, unknown>, label: string): EffectFrequency {
  if (!oneOf(record.frequency, EFFECT_FREQUENCIES)) throw new GameError(422, `${label} has to play every round or half of them.`);
  return record.frequency;
}

function spanField(record: Record<string, unknown>, label: string): EffectSpan {
  if (!oneOf(record.span, EFFECT_SPANS)) throw new GameError(422, `${label} has to last 25, 50, 75, or 100% of the round.`);
  return record.span;
}

function validateGreyscale(record: Record<string, unknown>): GreyscaleSetting {
  return { enabled: enabledField(record, 'Greyscale'), trigger: triggerField(record, 'Greyscale'), after: afterField(record, 'Greyscale') };
}

function validateBlur(record: Record<string, unknown>): BlurSetting {
  const strength = record.strength;
  if (!oneOf(strength, BLUR_STRENGTHS)) throw new GameError(422, 'Blur strength must be light, medium, or heavy.');
  return { enabled: enabledField(record, 'Blur'), trigger: triggerField(record, 'Blur'), after: afterField(record, 'Blur'), strength };
}

function validateFocus(record: Record<string, unknown>): FocusSetting {
  return { enabled: enabledField(record, 'Focus'), frequency: frequencyField(record, 'Focus'), span: spanField(record, 'Focus') };
}

function validateZoom(record: Record<string, unknown>): ZoomSetting {
  const scale = record.scale;
  if (!oneOf(scale, ZOOM_SCALES)) throw new GameError(422, 'Zoom must be 2×, 3×, or 4×.');
  return { enabled: enabledField(record, 'Zoom'), frequency: frequencyField(record, 'Zoom'), span: spanField(record, 'Zoom'), scale };
}

/** Both on with the same trigger: blur must be the later streak effect. */
export const blurStartsTooEarly = (effects: EffectsSettings) =>
  effects.greyscale.enabled &&
  effects.blur.enabled &&
  effects.greyscale.trigger === effects.blur.trigger &&
  effects.blur.after <= effects.greyscale.after;

// ---- normalization (persisted rooms written by an older build) ----

export function normalizeEffects(raw: unknown): EffectsSettings {
  const source = isRecord(raw) ? raw : {};
  const effects: EffectsSettings = {
    greyscale: normalizeStreakEffect(source.greyscale, { enabled: false, trigger: 'right', after: 3 }),
    blur: normalizeBlur(source.blur),
    focus: normalizeFocus(source.focus),
    zoom: normalizeZoom(source.zoom),
  };
  // Persisted state that breaks the ordering rule is nudged into a valid pair
  // rather than silently keeping a combination the lobby could never produce.
  if (blurStartsTooEarly(effects)) {
    effects.greyscale.after = Math.min(effects.greyscale.after, EFFECT_AFTER.max - 1);
    effects.blur.after = Math.max(effects.blur.after, effects.greyscale.after + 1);
  }
  return effects;
}

function normalizeStreakEffect<T extends { enabled: boolean; trigger: EffectTrigger; after: number }>(raw: unknown, fallback: T): T {
  if (!isRecord(raw)) return { ...fallback };
  return {
    ...fallback,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    trigger: oneOf(raw.trigger, EFFECT_TRIGGERS) ? raw.trigger : fallback.trigger,
    after: intIn(raw.after, EFFECT_AFTER) ? raw.after : fallback.after,
  };
}

function normalizeBlur(raw: unknown): BlurSetting {
  const base = normalizeStreakEffect(raw, defaultEffects().blur);
  const strength = isRecord(raw) && oneOf(raw.strength, BLUR_STRENGTHS) ? raw.strength : 'medium';
  return { ...base, strength };
}

function normalizeFocus(raw: unknown): FocusSetting {
  const fallback = defaultEffects().focus;
  if (!isRecord(raw)) return { ...fallback };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    frequency: oneOf(raw.frequency, EFFECT_FREQUENCIES) ? raw.frequency : fallback.frequency,
    span: oneOf(raw.span, EFFECT_SPANS) ? raw.span : fallback.span,
  };
}

function normalizeZoom(raw: unknown): ZoomSetting {
  const fallback = defaultEffects().zoom;
  if (!isRecord(raw)) return { ...fallback };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    frequency: oneOf(raw.frequency, EFFECT_FREQUENCIES) ? raw.frequency : fallback.frequency,
    span: oneOf(raw.span, EFFECT_SPANS) ? raw.span : fallback.span,
    scale: oneOf(raw.scale, ZOOM_SCALES) ? raw.scale : fallback.scale,
  };
}

// ---- reveal decisions ----

/** A private, per-player streak effect. `streak` is the count that earned it. */
export interface StreakEffect {
  kind: 'greyscale' | 'blur';
  strength?: BlurStrength;
  trigger: EffectTrigger;
  streak: number;
}

/** The round-wide effect. Focus has no degrees of freedom; zoom has three. */
export type RoundEffect =
  | { kind: 'focus'; spanMs: number }
  | { kind: 'zoom'; spanMs: number; scale: ZoomScale; originX: number; originY: number };

/**
 * Blur wins when both apply (the lobby guarantees blur starts later on the
 * same trigger, so a right-streak player crosses greyscale first and blur
 * later). The owner never asks for one; the game skips them.
 */
export function streakEffectFor(effects: EffectsSettings, streak: number, missStreak: number): StreakEffect | null {
  const count = (trigger: EffectTrigger) => (trigger === 'right' ? streak : missStreak);
  const blurCount = count(effects.blur.trigger);
  if (effects.blur.enabled && blurCount >= effects.blur.after)
    return { kind: 'blur', strength: effects.blur.strength, trigger: effects.blur.trigger, streak: blurCount };
  const greyscaleCount = count(effects.greyscale.trigger);
  if (effects.greyscale.enabled && greyscaleCount >= effects.greyscale.after)
    return { kind: 'greyscale', trigger: effects.greyscale.trigger, streak: greyscaleCount };
  return null;
}

const spanMs = (span: EffectSpan, timerSeconds: number) => Math.round((timerSeconds * 1000 * span) / 100);

/** `every` always; `half` a coin flip. If both effects fire, one is picked. */
export function roundEffectFor(effects: EffectsSettings, timerSeconds: number, random: FloatSource): RoundEffect | null {
  const plays = (setting: { enabled: boolean; frequency: EffectFrequency }) =>
    setting.enabled && (setting.frequency === 'every' || random.float() < 0.5);
  const focus = plays(effects.focus);
  const zoom = plays(effects.zoom);
  if (!focus && !zoom) return null;
  if (focus && zoom && random.float() >= 0.5) return zoomEffect(effects.zoom, timerSeconds, random);
  if (focus) return { kind: 'focus', spanMs: spanMs(effects.focus.span, timerSeconds) };
  return zoomEffect(effects.zoom, timerSeconds, random);
}

function zoomEffect(setting: ZoomSetting, timerSeconds: number, random: FloatSource): RoundEffect {
  return {
    kind: 'zoom',
    spanMs: spanMs(setting.span, timerSeconds),
    scale: setting.scale,
    // A random point in the middle half of the media, in both axes.
    originX: 0.25 + random.float() * 0.5,
    originY: 0.25 + random.float() * 0.5,
  };
}

/**
 * Sharp eyes: a correct guess while a round effect is easing earns up to 200,
 * scaled by how much of the effect's span was left. Zero once it has finished.
 */
export function sharpEyesBonus(effect: RoundEffect | null, elapsedMs: number): number {
  if (!effect) return 0;
  return Math.round(200 * Math.max(0, 1 - elapsedMs / effect.spanMs));
}
