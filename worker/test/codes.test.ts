import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, generateCode, isValidCode, joinURL, normalizeCode } from '../src/codes';

describe('room codes', () => {
  it('are 6 characters without ambiguous letters or digits', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[A-Z2-9]{6}$/);
      expect(code).not.toMatch(/[01OIL]/);
      expect(isValidCode(code)).toBe(true);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('use rejection sampling so bytes above the limit are skipped', () => {
    const bytes = [255, 254, 0, 1, 2, 3, 4, 5];
    let i = 0;
    const code = generateCode((n) => new Uint8Array(Array.from({ length: n }, () => bytes[i++ % bytes.length])));
    expect(code).toBe('ABCDEF');
  });

  it('are mostly unique', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateCode()));
    expect(seen.size).toBeGreaterThan(1990);
  });

  it('normalize user input and reject invalid codes', () => {
    expect(normalizeCode(' abc-234 ')).toBe('ABC234');
    expect(normalizeCode('ab c2 34')).toBe('ABC234');
    expect(normalizeCode('ABC10O')).toBeNull();
    expect(normalizeCode('ABCDE')).toBeNull();
    expect(normalizeCode('ABCDEFG')).toBeNull();
    expect(normalizeCode(42)).toBeNull();
  });

  it('build share links', () => {
    expect(joinURL('https://flashback.yoinklabs.dev/', 'ABC234')).toBe('https://flashback.yoinklabs.dev/join/ABC234');
  });
});
