// Pure settings rules (src/settingsModel.ts). Run with `npm test --prefix web`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EFFECTS, type RoomEffects } from '../src/types.ts';
import { fiftyFiftyPlayable, validEffects } from '../src/settingsModel.ts';

const effects = (patch: Partial<RoomEffects>): RoomEffects => ({ ...DEFAULT_EFFECTS, ...patch });

test('a valid pair is left exactly as it is', () => {
  const pair = effects({
    greyscale: { enabled: true, trigger: 'right', after: 3 },
    blur: { enabled: true, trigger: 'right', after: 5, strength: 'medium' },
  });
  assert.equal(validEffects(pair), pair);
});

test('same trigger with blur too early pushes blur after greyscale', () => {
  const pair = effects({
    greyscale: { enabled: true, trigger: 'wrong', after: 5 },
    blur: { enabled: true, trigger: 'wrong', after: 5, strength: 'heavy' },
  });
  const fixed = validEffects(pair);
  assert.equal(fixed.greyscale.after, 5);
  assert.equal(fixed.blur.after, 6);
});

test('at the top of the range greyscale steps down instead', () => {
  const pair = effects({
    greyscale: { enabled: true, trigger: 'right', after: 10 },
    blur: { enabled: true, trigger: 'right', after: 10, strength: 'light' },
  });
  const fixed = validEffects(pair);
  assert.equal(fixed.greyscale.after, 9);
  assert.equal(fixed.blur.after, 10);
});

test('other triggers and switched-off effects are untouched', () => {
  const other = effects({
    greyscale: { enabled: true, trigger: 'right', after: 6 },
    blur: { enabled: true, trigger: 'wrong', after: 4, strength: 'light' },
  });
  assert.equal(validEffects(other), other);
  const off = effects({
    greyscale: { enabled: false, trigger: 'right', after: 6 },
    blur: { enabled: true, trigger: 'right', after: 4, strength: 'light' },
  });
  assert.equal(validEffects(off), off);
});

test('a 50/50 needs at least two wrong choices to cut', () => {
  assert.equal(fiftyFiftyPlayable(2), false);
  // The owner of a 3-player room could, but the owner is hidden: stay safe.
  assert.equal(fiftyFiftyPlayable(3), false);
  assert.equal(fiftyFiftyPlayable(4), true);
  assert.equal(fiftyFiftyPlayable(8), true);
});
