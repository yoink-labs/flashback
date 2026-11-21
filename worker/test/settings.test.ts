import { describe, expect, it } from 'vitest';
import { defaultEffects } from '../src/effects';
import { GameError } from '../src/errors';
import {
  BREAK_SECONDS,
  ROUNDS,
  SWAPS,
  TIMER_SECONDS,
  applySettingsPatch,
  defaultSettings,
  normalizeSettings,
} from '../src/settings';
import { defaultPowerups } from '../src/shop';

function caught(fn: () => unknown): GameError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    return e as GameError;
  }
  throw new Error('expected a GameError');
}

function effects(patch: {
  greyscale?: Partial<ReturnType<typeof defaultEffects>['greyscale']>;
  blur?: Partial<ReturnType<typeof defaultEffects>['blur']>;
  focus?: Partial<ReturnType<typeof defaultEffects>['focus']>;
  zoom?: Partial<ReturnType<typeof defaultEffects>['zoom']>;
} = {}) {
  const base = defaultEffects();
  return {
    greyscale: { ...base.greyscale, ...patch.greyscale },
    blur: { ...base.blur, ...patch.blur },
    focus: { ...base.focus, ...patch.focus },
    zoom: { ...base.zoom, ...patch.zoom },
  };
}

describe('defaults', () => {
  it('has every M4 default', () => {
    expect(defaultSettings()).toEqual({
      rounds: 10,
      timerSeconds: 20,
      mediaMode: 'both',
      breakSeconds: 7,
      swaps: 3,
      evenSplit: false,
      effects: {
        greyscale: { enabled: false, trigger: 'right', after: 3 },
        blur: { enabled: false, trigger: 'right', after: 5, strength: 'medium' },
        focus: { enabled: false, frequency: 'every', span: 50 },
        zoom: { enabled: false, frequency: 'every', span: 50, scale: 4 },
      },
      powerups: {
        fiftyFifty: { enabled: false, after: 3 },
        shop: { enabled: false },
      },
    });
    expect(ROUNDS).toEqual({ min: 1, max: 100, default: 10 });
    expect(TIMER_SECONDS.max).toBe(60);
    expect(BREAK_SECONDS).toEqual({ min: 3, max: 30, default: 7 });
    expect(SWAPS).toEqual({ min: 0, max: 10, default: 3 });
  });

  it('returns fresh nested objects each time', () => {
    const a = defaultSettings();
    const b = defaultSettings();
    a.effects.blur.after = 9;
    a.powerups.shop.enabled = true;
    expect(b.effects.blur.after).toBe(5);
    expect(b.powerups.shop.enabled).toBe(false);
  });
});

describe('normalizing persisted settings', () => {
  it('turns nothing into the defaults', () => {
    for (const raw of [undefined, null, 42, 'settings', [], {}]) expect(normalizeSettings(raw)).toEqual(defaultSettings());
  });

  it('normalizes a Milestone 3 settings record, where M4 keys are missing', () => {
    const old = { rounds: 4, timerSeconds: 15, mediaMode: 'videos', breakSeconds: 9, swaps: 1 };
    expect(normalizeSettings(old)).toEqual({
      ...defaultSettings(),
      rounds: 4,
      timerSeconds: 15,
      mediaMode: 'videos',
      breakSeconds: 9,
      swaps: 1,
    });
  });

  it('keeps valid values and falls back field by field', () => {
    const normalized = normalizeSettings({
      rounds: 100,
      timerSeconds: 11,
      mediaMode: 'photos',
      breakSeconds: 30,
      swaps: 0,
      evenSplit: true,
      effects: {
        greyscale: { enabled: true, trigger: 'wrong', after: 2 },
        blur: { enabled: 'yes', trigger: 'sideways', after: 99, strength: 'heavy' },
        focus: { enabled: true, frequency: 'half', span: 75 },
        zoom: { enabled: true, frequency: 'sometimes', span: 30, scale: 3 },
      },
      powerups: {
        fiftyFifty: { enabled: true, after: 7 },
        shop: { enabled: 'on' },
      },
    });
    expect(normalized).toEqual({
      rounds: 100,
      timerSeconds: 11,
      mediaMode: 'photos',
      breakSeconds: 30,
      swaps: 0,
      evenSplit: true,
      effects: {
        greyscale: { enabled: true, trigger: 'wrong', after: 2 },
        blur: { enabled: false, trigger: 'right', after: 5, strength: 'heavy' },
        focus: { enabled: true, frequency: 'half', span: 75 },
        zoom: { enabled: true, frequency: 'every', span: 50, scale: 3 },
      },
      powerups: {
        fiftyFifty: { enabled: true, after: 7 },
        shop: { enabled: false },
      },
    });
  });

  it('repairs a persisted greyscale/blur pair that breaks the ordering rule', () => {
    const normalized = normalizeSettings({
      effects: {
        greyscale: { enabled: true, trigger: 'right', after: 9 },
        blur: { enabled: true, trigger: 'right', after: 4, strength: 'light' },
      },
    });
    expect(normalized.effects.greyscale.after).toBe(9);
    expect(normalized.effects.blur.after).toBe(10);
    expect(normalized.effects.blur.after).toBeGreaterThan(normalized.effects.greyscale.after);

    // At the top of the range the greyscale threshold moves down instead.
    const top = normalizeSettings({
      effects: {
        greyscale: { enabled: true, trigger: 'wrong', after: 10 },
        blur: { enabled: true, trigger: 'wrong', after: 2, strength: 'light' },
      },
    });
    expect(top.effects.greyscale.after).toBe(9);
    expect(top.effects.blur.after).toBe(10);
  });

  it('rejects impossible numbers and types', () => {
    const normalized = normalizeSettings({
      rounds: 101,
      timerSeconds: 5,
      mediaMode: 'gifs',
      breakSeconds: 2,
      swaps: 11,
      evenSplit: 'yes',
    });
    expect(normalized.rounds).toBe(10);
    expect(normalized.timerSeconds).toBe(20);
    expect(normalized.mediaMode).toBe('both');
    expect(normalized.breakSeconds).toBe(7);
    expect(normalized.swaps).toBe(3);
    expect(normalized.evenSplit).toBe(false);
  });
});

describe('settings patches', () => {
  it('applies any subset of the top-level keys', () => {
    const next = applySettingsPatch(defaultSettings(), {
      rounds: 1,
      timerSeconds: 60,
      mediaMode: 'photos',
      breakSeconds: 3,
      swaps: 10,
      evenSplit: true,
    });
    expect(next).toEqual({ ...defaultSettings(), rounds: 1, timerSeconds: 60, mediaMode: 'photos', breakSeconds: 3, swaps: 10, evenSplit: true });
  });

  it('leaves absent keys alone', () => {
    const current = { ...defaultSettings(), rounds: 25 };
    expect(applySettingsPatch(current, {})).toEqual(current);
    expect(applySettingsPatch(current, { effects: undefined, powerups: undefined, evenSplit: undefined })).toEqual(current);
  });

  it('allows rounds 1 through 100 and rejects everything else', () => {
    expect(applySettingsPatch(defaultSettings(), { rounds: 1 }).rounds).toBe(1);
    expect(applySettingsPatch(defaultSettings(), { rounds: 100 }).rounds).toBe(100);
    for (const rounds of [0, 101, 1.5, -10, NaN, Infinity, '5', null, true, {}, []]) {
      const e = caught(() => applySettingsPatch(defaultSettings(), { rounds }));
      expect(e.status).toBe(422);
      expect(e.message).toBe('Rounds must be 1–100.');
    }
  });

  it('validates the other primitive keys', () => {
    for (const timerSeconds of [9, 61, 20.5, '20']) expect(caught(() => applySettingsPatch(defaultSettings(), { timerSeconds })).status).toBe(422);
    for (const mediaMode of ['gif', '', null, 3]) expect(caught(() => applySettingsPatch(defaultSettings(), { mediaMode })).status).toBe(422);
    for (const breakSeconds of [2, 31, 7.5, '7']) expect(caught(() => applySettingsPatch(defaultSettings(), { breakSeconds })).status).toBe(422);
    for (const swaps of [-1, 11, 2.5, '3']) expect(caught(() => applySettingsPatch(defaultSettings(), { swaps })).status).toBe(422);
    for (const evenSplit of ['true', 1, null, {}]) {
      const e = caught(() => applySettingsPatch(defaultSettings(), { evenSplit }));
      expect(e.status).toBe(422);
      expect(e.message).toBe('Even Split must be on or off.');
    }
  });

  it('replaces the whole effects group and validates every field', () => {
    const valid = effects({
      greyscale: { enabled: true, trigger: 'wrong', after: 4 },
      blur: { enabled: true, trigger: 'wrong', after: 6, strength: 'heavy' },
      focus: { enabled: true, frequency: 'half', span: 25 },
      zoom: { enabled: true, frequency: 'half', span: 100, scale: 2 },
    });
    const next = applySettingsPatch(defaultSettings(), { effects: valid });
    expect(next.effects).toEqual(valid);

    const bad: [string, unknown][] = [
      ['not an object', 'effects'],
      ['missing zoom', { ...valid, zoom: undefined }],
      ['greyscale missing', { ...valid, greyscale: undefined }],
      ['enabled not a boolean', effects({ greyscale: { enabled: 'yes' } })],
      ['trigger', effects({ greyscale: { trigger: 'sideways' } })],
      ['after too low', effects({ greyscale: { after: 1 } })],
      ['after too high', effects({ blur: { after: 11 } })],
      ['after fractional', effects({ blur: { after: 3.5 } })],
      ['blur strength', effects({ blur: { strength: 'crunchy' } })],
      ['focus frequency', effects({ focus: { frequency: 'often' } })],
      ['focus span', effects({ focus: { span: 30 } })],
      ['zoom span', effects({ zoom: { span: 0 } })],
      ['zoom scale', effects({ zoom: { scale: 5 } })],
    ];
    for (const [label, value] of bad) expect(caught(() => applySettingsPatch(defaultSettings(), { effects: value })).status, label).toBe(422);
  });

  it('requires blur to start after greyscale on the same trigger', () => {
    const sameTrigger = effects({
      greyscale: { enabled: true, trigger: 'right', after: 4 },
      blur: { enabled: true, trigger: 'right', after: 4, strength: 'light' },
    });
    const e = caught(() => applySettingsPatch(defaultSettings(), { effects: sameTrigger }));
    expect(e.status).toBe(422);
    expect(e.message).toBe('Blur has to start after greyscale.');

    for (const after of [2, 3, 4]) {
      const tooEarly = effects({
        greyscale: { enabled: true, trigger: 'wrong', after: 5 },
        blur: { enabled: true, trigger: 'wrong', after, strength: 'light' },
      });
      expect(caught(() => applySettingsPatch(defaultSettings(), { effects: tooEarly })).message).toBe('Blur has to start after greyscale.');
    }
    // Strictly greater is fine, and so is a different trigger.
    expect(() => applySettingsPatch(defaultSettings(), { effects: effects({ greyscale: { enabled: true, trigger: 'right', after: 3 }, blur: { enabled: true, trigger: 'right', after: 4 } }) })).not.toThrow();
    expect(() => applySettingsPatch(defaultSettings(), { effects: effects({ greyscale: { enabled: true, trigger: 'right', after: 9 }, blur: { enabled: true, trigger: 'wrong', after: 2 } }) })).not.toThrow();
    // Disabled effects are not ordered.
    expect(() => applySettingsPatch(defaultSettings(), { effects: effects({ greyscale: { enabled: false, trigger: 'right', after: 9 }, blur: { enabled: false, trigger: 'right', after: 2 } }) })).not.toThrow();
  });

  it('validates power-ups', () => {
    const valid = { fiftyFifty: { enabled: true, after: 2 }, shop: { enabled: true } };
    expect(applySettingsPatch(defaultSettings(), { powerups: valid }).powerups).toEqual(valid);
    const bad = [
      null,
      { fiftyFifty: { enabled: true, after: 2 } },
      { shop: { enabled: true } },
      { fiftyFifty: { enabled: 'yes', after: 2 }, shop: { enabled: true } },
      { fiftyFifty: { enabled: true, after: 1 }, shop: { enabled: true } },
      { fiftyFifty: { enabled: true, after: 11 }, shop: { enabled: true } },
      { fiftyFifty: { enabled: true, after: 2 }, shop: { enabled: 'yes' } },
    ];
    for (const powerups of bad) expect(caught(() => applySettingsPatch(defaultSettings(), { powerups })).status).toBe(422);
    expect(defaultSettings().powerups).toEqual(defaultPowerups());
  });
});
