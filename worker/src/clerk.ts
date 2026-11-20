// Optional Clerk sign-in, verified the same way as Split: RS256 JWTs from the
// shared Yoink Labs instance, checked against its JWKS with an allowed-party list.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const CLERK_JWKS_URL = 'https://clerk.yoinklabs.dev/.well-known/jwks.json';
const remoteKeys = createRemoteJWKSet(new URL(CLERK_JWKS_URL));
let keys: JWTVerifyGetKey = remoteKeys;

/** Origins and bundle ids allowed to mint tokens for Flashback (Clerk `azp`). */
export function allowedParties(webURL: string) {
  return [webURL, 'https://flashback.yoinklabs.dev', 'com.yoinklabs.flashback', 'https://yoinklabs.dev', 'https://www.yoinklabs.dev'];
}

export function validParty(azp: unknown, webURL: string) {
  return azp === undefined || (typeof azp === 'string' && allowedParties(webURL).includes(azp));
}

export interface ClerkIdentity {
  sub: string;
}

export async function verifyClerk(token: string, env: { CLERK_ISSUER: string; WEB_URL: string }): Promise<ClerkIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: env.CLERK_ISSUER, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'iat'] });
    if (!payload.sub || !validParty(payload.azp, env.WEB_URL)) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

/** Tests swap in a local JWKS fixture. Production always uses the remote JWKS. */
export function useClerkKeysForTesting(resolver: JWTVerifyGetKey | null) {
  keys = resolver ?? remoteKeys;
}
