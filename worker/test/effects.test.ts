import { describe, expect, it } from 'vitest';
import { defaultEffects, roundEffectFor, sharpEyesBonus, streakEffectFor, type EffectsSettings } from '../src/effects';

function fixed(values: number[], fallback = 0) {
  let i = 0;
  return { float: () => (i < values.length ? values[i++] : fallback) };
}

function withEffects(patch: {
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

describe('streak effects', () => {
  it('starts at the threshold, not before it', () => {
    const effects = withEffects({ greyscale: { enabled: true, trigger: 'right', after: 3 } });
    expect(streakEffectFor(effects, 0, 0)).toBeNull();
    expect(streakEffectFor(effects, 2, 0)).toBeNull();
    expect(streakEffectFor(effects, 3, 0)).toEqual({ kind: 'greyscale', trigger: 'right', streak: 3 });
    expect(streakEffectFor(effects, 9, 0)).toEqual({ kind: 'greyscale', trigger: 'right', streak: 9 });
  });

  it('watches a wrong streak when the trigger is wrong', () => {
    const effects = withEffects({ greyscale: { enabled: true, trigger: 'wrong', after: 2 } });
    expect(streakEffectFor(effects, 8, 1)).toBeNull();
    expect(streakEffectFor(effects, 0, 2)).toEqual({ kind: 'greyscale', trigger: 'wrong', streak: 2 });
    expect(streakEffectFor(effects, 8, 3)).toEqual({ kind: 'greyscale', trigger: 'wrong', streak: 3 });
  });

  it('prefers blur, which always starts later on the same trigger', () => {
    const effects = withEffects({
      greyscale: { enabled: true, trigger: 'right', after: 3 },
      blur: { enabled: true, trigger: 'right', after: 5, strength: 'heavy' },
    });
    expect(streakEffectFor(effects, 2, 0)).toBeNull();
    expect(streakEffectFor(effects, 3, 0)).toEqual({ kind: 'greyscale', trigger: 'right', streak: 3 });
    expect(streakEffectFor(effects, 4, 0)).toEqual({ kind: 'greyscale', trigger: 'right', streak: 4 });
    expect(streakEffectFor(effects, 5, 0)).toEqual({ kind: 'blur', strength: 'heavy', trigger: 'right', streak: 5 });
  });

  it('picks each effect by its own trigger', () => {
    const effects = withEffects({
      greyscale: { enabled: true, trigger: 'right', after: 2 },
      blur: { enabled: true, trigger: 'wrong', after: 2, strength: 'light' },
    });
    expect(streakEffectFor(effects, 2, 0)).toEqual({ kind: 'greyscale', trigger: 'right', streak: 2 });
    expect(streakEffectFor(effects, 0, 2)).toEqual({ kind: 'blur', strength: 'light', trigger: 'wrong', streak: 2 });
  });

  it('does nothing when both effects are off', () => {
    const effects = withEffects({});
    expect(streakEffectFor(effects, 100, 100)).toBeNull();
  });

  it('ignores a disabled blur and still greyscales', () => {
    const effects = withEffects({
      greyscale: { enabled: true, trigger: 'right', after: 2 },
      blur: { enabled: false, trigger: 'right', after: 3, strength: 'heavy' },
    });
    expect(streakEffectFor(effects, 5, 0)).toEqual({ kind: 'greyscale', trigger: 'right', streak: 5 });
  });
});

describe('round effects', () => {
  it('stays off when nothing is enabled and consumes no randomness', () => {
    let calls = 0;
    const random = { float: () => (calls++, 0.1) };
    expect(roundEffectFor(defaultEffects(), 20, random)).toBeNull();
    expect(calls).toBe(0);
  });

  it('always plays an `every` focus with the span as a share of the timer', () => {
    const spans: [25 | 50 | 75 | 100, number][] = [
      [25, 5_000],
      [50, 10_000],
      [75, 15_000],
      [100, 20_000],
    ];
    for (const [span, ms] of spans) {
      const effects = withEffects({ focus: { enabled: true, frequency: 'every', span } });
      expect(roundEffectFor(effects, 20, fixed([]))).toEqual({ kind: 'focus', spanMs: ms });
    }
    const short = withEffects({ focus: { enabled: true, frequency: 'every', span: 25 } });
    expect(roundEffectFor(short, 10, fixed([]))).toEqual({ kind: 'focus', spanMs: 2_500 });
  });

  it('plays half the rounds on a coin flip', () => {
    const effects = withEffects({ focus: { enabled: true, frequency: 'half', span: 50 } });
    expect(roundEffectFor(effects, 20, fixed([0.49]))).toEqual({ kind: 'focus', spanMs: 10_000 });
    expect(roundEffectFor(effects, 20, fixed([0.5]))).toBeNull();
    expect(roundEffectFor(effects, 20, fixed([0.99]))).toBeNull();
  });

  it('zooms from a random point in the middle half of the media', () => {
    const effects = withEffects({ zoom: { enabled: true, frequency: 'every', span: 50, scale: 3 } });
    const effect = roundEffectFor(effects, 20, fixed([0.5, 0.5]));
    expect(effect).toEqual({ kind: 'zoom', spanMs: 10_000, scale: 3, originX: 0.5, originY: 0.5 });
  });

  it('keeps every zoom origin within [0.25, 0.75]', () => {
    const effects = withEffects({ zoom: { enabled: true, frequency: 'every', span: 25, scale: 2 } });
    let state = 7;
    const random = {
      float: () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 2 ** 32;
      },
    };
    for (let i = 0; i < 200; i++) {
      const effect = roundEffectFor(effects, 30, random);
      if (!effect || effect.kind !== 'zoom') throw new Error('expected a zoom');
      expect(effect.originX).toBeGreaterThanOrEqual(0.25);
      expect(effect.originX).toBeLessThanOrEqual(0.75);
      expect(effect.originY).toBeGreaterThanOrEqual(0.25);
      expect(effect.originY).toBeLessThanOrEqual(0.75);
      expect(effect.spanMs).toBe(7_500);
    }
  });

  it('picks one at random when both fire', () => {
    const effects = withEffects({
      focus: { enabled: true, frequency: 'every', span: 25 },
      zoom: { enabled: true, frequency: 'every', span: 100, scale: 4 },
    });
    expect(roundEffectFor(effects, 20, fixed([0.2]))).toEqual({ kind: 'focus', spanMs: 5_000 });
    expect(roundEffectFor(effects, 20, fixed([0.8, 0.25, 0.75]))).toEqual({ kind: 'zoom', spanMs: 20_000, scale: 4, originX: 0.375, originY: 0.625 });
  });

  it('uses whichever effect actually fired', () => {
    const zoomOnly = withEffects({ zoom: { enabled: true, frequency: 'every', span: 50, scale: 2 } });
    expect(roundEffectFor(zoomOnly, 20, fixed([0.5, 0.5]))).toMatchObject({ kind: 'zoom', scale: 2 });

    const focusEveryZoomHalf = withEffects({
      focus: { enabled: true, frequency: 'every', span: 50 },
      zoom: { enabled: true, frequency: 'half', span: 50, scale: 2 },
    });
    expect(roundEffectFor(focusEveryZoomHalf, 20, fixed([0.9]))).toEqual({ kind: 'focus', spanMs: 10_000 });

    const focusHalfZoomEvery = withEffects({
      focus: { enabled: true, frequency: 'half', span: 50 },
      zoom: { enabled: true, frequency: 'every', span: 50, scale: 2 },
    });
    expect(roundEffectFor(focusHalfZoomEvery, 20, fixed([0.9, 0.5, 0.5]))).toMatchObject({ kind: 'zoom' });
  });
});

describe('sharp eyes', () => {
  const focus = { kind: 'focus' as const, spanMs: 10_000 };

  it('pays nothing without a round effect', () => {
    expect(sharpEyesBonus(null, 0)).toBe(0);
    expect(sharpEyesBonus(null, 5_000)).toBe(0);
  });

  it('pays up to 200, scaled by the span that is left', () => {
    expect(sharpEyesBonus(focus, 0)).toBe(200);
    expect(sharpEyesBonus(focus, 2_500)).toBe(150);
    expect(sharpEyesBonus(focus, 5_000)).toBe(100);
    expect(sharpEyesBonus(focus, 7_500)).toBe(50);
    expect(sharpEyesBonus(focus, 9_900)).toBe(2);
    expect(sharpEyesBonus(focus, 10_000)).toBe(0);
    expect(sharpEyesBonus(focus, 15_000)).toBe(0);
  });

  it('rounds to the nearest point', () => {
    expect(sharpEyesBonus(focus, 3_333)).toBe(133);
    expect(sharpEyesBonus({ kind: 'focus', spanMs: 15_000 }, 5_000)).toBe(133);
    expect(sharpEyesBonus({ kind: 'focus', spanMs: 15_000 }, 14_999)).toBe(0);
  });

  it('works the same for a zoom', () => {
    const zoom = { kind: 'zoom' as const, spanMs: 20_000, scale: 3 as const, originX: 0.5, originY: 0.5 };
    expect(sharpEyesBonus(zoom, 0)).toBe(200);
    expect(sharpEyesBonus(zoom, 10_000)).toBe(100);
    expect(sharpEyesBonus(zoom, 20_000)).toBe(0);
  });
});
