import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { issueSession, newSessionKey, SESSION_TTL_SECONDS, tokenKind, verifySession } from '../src/session';

const claims = { code: 'ABC234', instance: 'inst1', playerID: 'g_1', nickname: 'Sam', kind: 'guest' as const };

describe('guest room sessions', () => {
  it('issue and validate a room-scoped token', async () => {
    const key = newSessionKey();
    const { token, expiresAt } = await issueSession(key, claims, 1_000);
    expect(expiresAt).toBe(1_000 + SESSION_TTL_SECONDS);
    expect(tokenKind(token)).toBe('room');
    expect(await verifySession(key, token, 'ABC234', 'inst1', 1_010)).toEqual({ ...claims, expiresAt });
  });

  it('reject other rooms, other room instances, other keys, and expired tokens', async () => {
    const key = newSessionKey();
    const { token } = await issueSession(key, claims, 1_000);
    expect(await verifySession(key, token, 'XYZ789', 'inst1', 1_010)).toBeNull();
    expect(await verifySession(key, token, 'ABC234', 'inst2', 1_010)).toBeNull();
    expect(await verifySession(newSessionKey(), token, 'ABC234', 'inst1', 1_010)).toBeNull();
    expect(await verifySession(key, token, 'ABC234', 'inst1', 1_000 + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it('reject tampered tokens', async () => {
    const key = newSessionKey();
    const { token } = await issueSession(key, claims, 1_000);
    const [h, p, s] = token.split('.');
    const forged = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
    forged.sub = 'g_2';
    const body = btoa(JSON.stringify(forged)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(await verifySession(key, `${h}.${body}.${s}`, 'ABC234', 'inst1', 1_010)).toBeNull();
    expect(await verifySession(key, 'not-a-token', 'ABC234', 'inst1', 1_010)).toBeNull();
  });

  it('reject tokens missing the room claims', async () => {
    const key = newSessionKey();
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer('flashback').setAudience('room:ABC234').setSubject('g_1').setIssuedAt(1_000).setExpirationTime(5_000).sign(key);
    expect(await verifySession(key, token, 'ABC234', 'inst1', 1_010)).toBeNull();
  });

  it('tell room sessions from Clerk tokens', () => {
    expect(tokenKind('eyJhbGciOiJSUzI1NiJ9.e30.x')).toBe('clerk');
    expect(tokenKind('eyJhbGciOiJub25lIn0.e30.')).toBeNull();
    expect(tokenKind('garbage')).toBeNull();
  });
});
