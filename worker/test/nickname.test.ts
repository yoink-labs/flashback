import { describe, expect, it } from 'vitest';
import { assertUniqueNickname, normalizeNickname, visibleLength } from '../src/nickname';

describe('nicknames', () => {
  it('trim and collapse whitespace', () => {
    expect(normalizeNickname('  Sam   Lee \n')).toBe('Sam Lee');
  });
  it('reject empty and whitespace-only names', () => {
    for (const bad of ['', '   ', '\t\n', '​​', null, 7]) expect(() => normalizeNickname(bad)).toThrow(/Choose a nickname/);
  });
  it('allow 24 visible characters, counting emoji as one', () => {
    expect(normalizeNickname('a'.repeat(24))).toHaveLength(24);
    expect(() => normalizeNickname('a'.repeat(25))).toThrow(/up to 24/);
    expect(visibleLength('👍🏽👨‍👩‍👧')).toBe(2);
    expect(normalizeNickname('👍🏽'.repeat(24))).toBeTruthy();
  });
  it('are unique case-insensitively', () => {
    expect(() => assertUniqueNickname('SAM', ['sam'])).toThrow(/already in this room/);
    expect(() => assertUniqueNickname('Ｓａｍ', ['sam'])).toThrow(/already in this room/);
    expect(() => assertUniqueNickname('Sammy', ['sam'])).not.toThrow();
  });
});
