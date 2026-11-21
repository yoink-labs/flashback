// HTTP calls to the Flashback Worker and the room session store.
//
// Two ways in, same room:
//   • Guest: POST /v1/rooms or /v1/rooms/:code/join with just a nickname.
//   • Signed in: the same calls with a Clerk session token (Authorization: Bearer).
// Both return a short-lived room session token (Worker-signed, scoped to one room
// and one player) that the app keeps in localStorage for reconnects.
//
// The only other request in Milestone 2 is the owner's one-item upload for a
// round (POST /v1/rooms/:code/media?slot=…). There is no media download: items
// arrive over the WebSocket instead.
import { clerkToken } from './clerk';
import type { RoomSettings } from './types';

export interface RoomSession {
  code: string;
  playerID: string;
  nickname: string;
  token: string;
  expiresAt: number;
  joinURL: string;
}

export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const key = (code: string) => `flashback.session.${code}`;

export function savedSession(code: string): RoomSession | null {
  try {
    const session = JSON.parse(localStorage.getItem(key(code)) ?? 'null') as RoomSession | null;
    if (session && session.expiresAt * 1000 > Date.now()) return session;
  } catch {}
  localStorage.removeItem(key(code));
  return null;
}

export function saveSession(session: RoomSession) {
  localStorage.setItem(key(session.code), JSON.stringify(session));
}

export function forgetSession(code: string) {
  localStorage.removeItem(key(code));
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: 'no-store', ...init });
  } catch {
    throw new APIError(0, 'Could not reach Flashback. Check your connection.');
  }
  if (!res.ok) throw new APIError(res.status, (await res.json().catch(() => ({})) as { error?: string }).error ?? 'Something went wrong. Try again.');
  return res.json() as Promise<T>;
}

async function enter(path: string, nickname: string, signedIn: boolean) {
  const token = signedIn ? await clerkToken() : null;
  if (signedIn && !token) throw new APIError(401, 'Sign in again, or continue as a guest.');
  const session = await call<RoomSession>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ nickname }),
  });
  saveSession(session);
  return session;
}

/** Guest join path (no account) when `signedIn` is false; Clerk path when true. */
export const createRoom = (nickname: string, signedIn: boolean) => enter('/v1/rooms', nickname, signedIn);
export const joinRoom = (code: string, nickname: string, signedIn: boolean) => enter(`/v1/rooms/${code}/join`, nickname, signedIn);

/** Preview of a room before joining: host name, settings, player count. */
export interface RoomInfo {
  code: string;
  phase: string;
  players: number;
  capacity: number;
  joinable: boolean;
  host?: string;
  settings?: RoomSettings;
}
export const roomInfo = (code: string) => call<RoomInfo>(`/v1/rooms/${code}`);

/**
 * Upload the one prepared item for a slot. The room token authorizes it; the
 * server tells us the slot in the private `turn` message. Resolves quietly: the
 * owner's own copy is cached locally, so no response body is needed.
 */
export async function uploadMedia(session: RoomSession, slot: string, blob: Blob, contentType: 'image/jpeg' | 'video/mp4') {
  let res: Response;
  try {
    res = await fetch(`/v1/rooms/${session.code}/media?slot=${encodeURIComponent(slot)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': contentType },
      body: blob,
      cache: 'no-store',
      // The server reassigns a slot after 20 s; do not block the turn queue
      // forever on a stalled upload.
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new APIError(0, 'Could not reach Flashback.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new APIError(res.status, body.error ?? 'That upload did not go through.');
  }
}

export async function leaveRoom(session: RoomSession) {
  await fetch(`/v1/rooms/${session.code}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } }).catch(() => {});
  forgetSession(session.code);
}

/** Codes use an unambiguous alphabet (no 0/O/1/I), so anything else is dropped. */
export const normalizeCode = (input: string) => input.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '').slice(0, 6);
export const isCode = (code: string) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code);

/** The player's own last nickname, remembered on this device. */
export const savedNickname = () => localStorage.getItem('flashback.nickname') ?? '';
export const rememberNickname = (nickname: string) => localStorage.setItem('flashback.nickname', nickname);
