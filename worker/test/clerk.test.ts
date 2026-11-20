import { afterEach, describe, expect, it } from 'vitest';
import { useClerkKeysForTesting, validParty, verifyClerk } from '../src/clerk';
import { clerkFixture } from './helpers';

const env = { CLERK_ISSUER: 'https://clerk.yoinklabs.dev', WEB_URL: 'https://flashback.yoinklabs.dev' };
afterEach(() => useClerkKeysForTesting(null));

describe('Clerk JWT verification (fixtures, no real secrets)', () => {
  it('accepts a valid RS256 token from the shared issuer', async () => {
    const clerk = await clerkFixture();
    useClerkKeysForTesting(clerk.jwks);
    expect(await verifyClerk(await clerk.sign({ azp: 'https://flashback.yoinklabs.dev' }), env)).toEqual({ sub: 'user_123' });
    expect(await verifyClerk(await clerk.sign({ azp: 'com.yoinklabs.flashback' }), env)).toEqual({ sub: 'user_123' });
    expect(await verifyClerk(await clerk.sign(), env)).toEqual({ sub: 'user_123' });
  });

  it('rejects wrong issuers, expired tokens, missing claims, foreign parties, and other keys', async () => {
    const clerk = await clerkFixture();
    const other = await clerkFixture();
    useClerkKeysForTesting(clerk.jwks);
    expect(await verifyClerk(await clerk.sign({}, { issuer: 'https://evil.example' }), env)).toBeNull();
    expect(await verifyClerk(await clerk.sign({}, { expiresIn: '-1m' }), env)).toBeNull();
    expect(await verifyClerk(await clerk.sign({}, { sub: null }), env)).toBeNull();
    expect(await verifyClerk(await clerk.sign({}, { iat: false }), env)).toBeNull();
    expect(await verifyClerk(await clerk.sign({ azp: 'https://evil.example' }), env)).toBeNull();
    expect(await verifyClerk(await other.sign(), env)).toBeNull();
    expect(await verifyClerk('not.a.jwt', env)).toBeNull();
  });

  it('allows Flashback and shared Yoink Labs parties', () => {
    for (const azp of [undefined, 'https://flashback.yoinklabs.dev', 'com.yoinklabs.flashback', 'https://yoinklabs.dev', 'https://www.yoinklabs.dev', 'http://localhost:5173'])
      expect(validParty(azp, azp === 'http://localhost:5173' ? azp : env.WEB_URL)).toBe(true);
    for (const azp of ['https://split.yoinklabs.dev', 'com.yoinklabs.split', 7, null]) expect(validParty(azp, env.WEB_URL)).toBe(false);
  });
});
