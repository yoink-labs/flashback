// Room session tokens. Every player (guest or signed in) receives one when they
// create or join a room. They are HS256 JWTs signed with a random key that lives
// only inside that room's Durable Object, so they authorize exactly one room,
// one player id, and one nickname, and they die with the room.
import { SignJWT, jwtVerify, decodeProtectedHeader } from 'jose';

export const SESSION_ISSUER = 'flashback';
export const SESSION_TTL_SECONDS = 4 * 60 * 60;
export const SESSION_REFRESH_WINDOW_SECONDS = 60 * 60;

export interface SessionClaims {
  code: string;
  instance: string;
  playerID: string;
  nickname: string;
  kind: 'guest' | 'clerk';
}
export interface VerifiedSession extends SessionClaims {
  expiresAt: number;
}

export const newSessionKey = () => crypto.getRandomValues(new Uint8Array(32));

export async function issueSession(key: Uint8Array, claims: SessionClaims, nowSeconds = Math.floor(Date.now() / 1000)) {
  const expiresAt = nowSeconds + SESSION_TTL_SECONDS;
  const token = await new SignJWT({ rid: claims.instance, nick: claims.nickname, knd: claims.kind })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(`room:${claims.code}`)
    .setSubject(claims.playerID)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAt)
    .sign(key);
  return { token, expiresAt };
}

export async function verifySession(key: Uint8Array, token: string, code: string, instance: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: SESSION_ISSUER,
      audience: `room:${code}`,
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
      currentDate: new Date(nowSeconds * 1000),
    });
    if (payload.rid !== instance || typeof payload.sub !== 'string' || typeof payload.nick !== 'string') return null;
    if (payload.knd !== 'guest' && payload.knd !== 'clerk') return null;
    return { code, instance, playerID: payload.sub, nickname: payload.nick, kind: payload.knd, expiresAt: payload.exp! };
  } catch {
    return null;
  }
}

/** Room sessions are HS256; Clerk session tokens are RS256. */
export function tokenKind(token: string): 'room' | 'clerk' | null {
  try {
    const { alg } = decodeProtectedHeader(token);
    return alg === 'HS256' ? 'room' : alg === 'RS256' ? 'clerk' : null;
  } catch {
    return null;
  }
}
