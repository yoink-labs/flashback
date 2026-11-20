// HTTP calls to the Flashback Worker and the room session store.
//
// Two ways in, same room:
//   • Guest: POST /v1/rooms or /v1/rooms/:code/join with just a nickname.
//   • Signed in: the same calls with a Clerk session token (Authorization: Bearer).
// Both return a short-lived room session token (Worker-signed, scoped to one room
// and one player) that the app keeps in localStorage for reconnects.
import { clerkToken } from './clerk';

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

export interface RoomInfo {
  code: string;
  phase: string;
  players: number;
  capacity: number;
  joinable: boolean;
}
export const roomInfo = (code: string) => call<RoomInfo>(`/v1/rooms/${code}`);

export const uploadMedia = (session: RoomSession, blob: Blob, type: 'image/jpeg' | 'video/mp4') =>
  call<{ item: { id: string; kind: string } }>(`/v1/rooms/${session.code}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': type },
    body: blob,
  });

export async function fetchMedia(session: RoomSession, path: string, signal?: AbortSignal) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${session.token}` }, cache: 'no-store', signal });
  if (!res.ok) throw new APIError(res.status, 'This photo or video is no longer available.');
  return res.blob();
}

export async function leaveRoom(session: RoomSession) {
  await fetch(`/v1/rooms/${session.code}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } }).catch(() => {});
  forgetSession(session.code);
}

export const normalizeCode = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
export const isCode = (code: string) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code);
