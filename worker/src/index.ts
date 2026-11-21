// Flashback Worker: HTTP API, WebSocket routing, and the web app's static assets.
//
//   POST   /v1/rooms                       create a room (guest or Clerk), returns a room session
//   GET    /v1/rooms/:code                 public room preview (host, players, settings)
//   POST   /v1/rooms/:code/join            join with a nickname (guest or Clerk), returns a room session
//   GET    /v1/rooms/:code/ws              WebSocket (auth: Sec-WebSocket-Protocol "flashback.v2, auth.<token>" or Bearer)
//   POST   /v1/rooms/:code/media?slot=<id> upload the item for one `turn` (the slot's owner only)
//   POST   /v1/rooms/:code/leave           leave the room
//
// Media never touches storage: the room Durable Object holds the one item for an
// open slot in memory and pushes it to the other players as a binary WebSocket
// frame. Every authenticated route accepts either a Clerk session token (RS256,
// verified here) or a room session token (HS256, verified by the room's Durable
// Object).
import { verifyClerk } from './clerk';
import { generateCode, joinURL, normalizeCode } from './codes';
import { tokenKind } from './session';
import { IDENTITY_HEADER, WS_PROTOCOL, type ForwardedIdentity } from './room';

export { Room } from './room';

class HTTPError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function readJSON(request: Request, limit = 4096): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HTTPError(415, 'Send JSON.');
  const text = await request.text();
  if (text.length > limit) throw new HTTPError(413, 'Request too large.');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new HTTPError(400, 'Invalid JSON.');
  }
}

/** Token from `Authorization: Bearer …`, or from a WebSocket subprotocol `auth.…` (browsers cannot set headers on WebSockets). */
export function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];
  if (header) return header;
  const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((p) => p.trim()) ?? [];
  return protocols.find((p) => p.startsWith('auth.'))?.slice(5) || null;
}

/** Resolves a token to an identity the room can trust. Clerk is checked here; room sessions in the room. */
async function identify(token: string | null, env: Env, required: boolean): Promise<ForwardedIdentity> {
  if (!token) {
    if (required) throw new HTTPError(401, 'Join the room to continue.');
    return { kind: 'anonymous' };
  }
  const kind = tokenKind(token);
  if (kind === 'clerk') {
    const clerk = await verifyClerk(token, env);
    if (!clerk) throw new HTTPError(401, 'Your session expired. Sign in again, or play as a guest.');
    return { kind: 'clerk', sub: clerk.sub };
  }
  if (kind === 'room' && required) return { kind: 'room', token };
  throw new HTTPError(401, required ? 'Your room session ended. Join again.' : 'Sign in again, or play as a guest.');
}

function roomStub(env: Env, code: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

function forward(env: Env, code: string, path: string, init: RequestInit & { identity: ForwardedIdentity }) {
  const headers = new Headers(init.headers);
  headers.set(IDENTITY_HEADER, JSON.stringify(init.identity));
  return roomStub(env, code).fetch(`https://room${path}`, { ...init, headers });
}

async function createRoom(request: Request, env: Env) {
  const body = await readJSON(request);
  const identity = await identify(bearer(request), env, false);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode();
    const response = await forward(env, code, '/create', {
      method: 'POST',
      identity,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, nickname: body.nickname }),
    });
    if (response.status === 409 && (await response.clone().json<{ error: string }>()).error === 'taken') continue;
    if (!response.ok) return response;
    const created = await response.json<Record<string, unknown>>();
    return json({ ...created, joinURL: joinURL(env.WEB_URL, code) }, 201);
  }
  throw new HTTPError(503, 'Could not find a free room code. Try again.');
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/health') return json({ service: 'flashback', status: 'ok' });
  if (path === '/.well-known/apple-app-site-association')
    return json({ applinks: { details: [{ appIDs: ['64PUT29XZ8.com.yoinklabs.flashback'], components: [{ '/': '/join/*' }] }] } });
  if (path === '/v1/rooms' && request.method === 'POST') return createRoom(request, env);

  const match = path.match(/^\/v1\/rooms\/([^/]+)(?:\/([a-z]+))?(?:\/([A-Za-z0-9]+))?$/);
  if (!match) throw new HTTPError(404, 'Not found.');
  const code = normalizeCode(decodeURIComponent(match[1]));
  if (!code) throw new HTTPError(404, 'Room codes are 6 letters and numbers.');
  const [, , action, arg] = match;

  if (!action && request.method === 'GET') return forward(env, code, '/info', { method: 'GET', identity: { kind: 'anonymous' } });
  if (action === 'join' && request.method === 'POST') {
    const body = await readJSON(request);
    const identity = await identify(bearer(request), env, false);
    const response = await forward(env, code, '/join', { method: 'POST', identity, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: body.nickname }) });
    if (!response.ok) return response;
    return json({ ...(await response.json<Record<string, unknown>>()), joinURL: joinURL(env.WEB_URL, code) });
  }
  if (action === 'ws' && request.method === 'GET') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HTTPError(426, 'Expected a WebSocket.');
    const identity = await identify(bearer(request), env, true);
    // Forward the original request so the upgrade and subprotocol headers survive.
    const headers = new Headers(request.headers);
    headers.set(IDENTITY_HEADER, JSON.stringify(identity));
    headers.delete('Authorization');
    const offered = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((p) => p.trim()) ?? [];
    const accepted = offered.filter((p) => p === WS_PROTOCOL);
    if (accepted.length) headers.set('Sec-WebSocket-Protocol', accepted.join(', '));
    return roomStub(env, code).fetch(new Request('https://room/ws', { method: 'GET', headers }));
  }
  if (action === 'media' && request.method === 'POST' && !arg) {
    const slot = url.searchParams.get('slot');
    if (!slot) throw new HTTPError(400, 'Which turn?');
    const identity = await identify(bearer(request), env, true);
    const headers: Record<string, string> = { 'Content-Type': request.headers.get('Content-Type') ?? '' };
    const length = request.headers.get('Content-Length');
    if (length) headers['Content-Length'] = length;
    return forward(env, code, `/media?slot=${encodeURIComponent(slot)}`, { method: 'POST', identity, headers, body: request.body });
  }
  if (action === 'leave' && request.method === 'POST') {
    const identity = await identify(bearer(request), env, true);
    return forward(env, code, '/leave', { method: 'POST', identity });
  }
  throw new HTTPError(404, 'Not found.');
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HTTPError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'request_failed', type: error instanceof Error ? error.name : 'unknown' }));
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
