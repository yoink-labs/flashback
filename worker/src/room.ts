// One Durable Object per room. It owns the room state, the room's session
// signing key, the WebSocket connections (hibernatable), and the room's media in
// R2. The Worker authenticates Clerk tokens and forwards requests here with an
// internal identity header; this object is not reachable from the internet.
import { DurableObject } from 'cloudflare:workers';
import { CAPACITY, Game, GameError, newRoom, defaultRandomness, type Randomness, type RoomState } from './game';
import { kindForContentType, maxBytes, MediaError, validateMedia } from './media';
import { issueSession, newSessionKey, verifySession, SESSION_REFRESH_WINDOW_SECONDS } from './session';
import { randomID } from './codes';

export const IDENTITY_HEADER = 'x-flashback-identity';
export const WS_PROTOCOL = 'flashback.v1';

export type ForwardedIdentity = { kind: 'room'; token: string } | { kind: 'clerk'; sub: string } | { kind: 'anonymous' };

interface Attachment {
  playerID: string;
}

export const mediaPath = (code: string, capability: string) => `/v1/rooms/${code}/media/${capability}`;
export const roomPrefix = (state: Pick<RoomState, 'code' | 'instance'>) => `rooms/${state.code}/${state.instance}/`;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export class Room extends DurableObject<Env> {
  private state: RoomState | null = null;
  private key: Uint8Array | null = null;
  /** Overridable in tests for deterministic picks. */
  random: Randomness = defaultRandomness;
  /** Overridable in tests to move time forward. */
  now: () => number = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>('room')) ?? null;
      this.key = (await ctx.storage.get<Uint8Array>('key')) ?? null;
    });
  }

  // ---- plumbing ----

  private game() {
    if (!this.state || this.state.phase === 'closed') throw new GameError(404, 'That room does not exist or has closed.');
    // Work on a copy so a failed request never leaves half-applied state behind.
    const game = new Game(structuredClone(this.state), this.random);
    game.tick(this.now());
    return game;
  }

  /** Persists state, performs deletions, schedules the alarm, and broadcasts. */
  private async commit(game: Game) {
    if (game.deletions.length) await this.env.MEDIA.delete([...new Set(game.deletions)]);
    if (game.state.phase === 'closed') return this.destroy();
    this.state = game.state;
    await this.ctx.storage.put('room', game.state);
    const next = game.nextDeadline();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    this.broadcast(game, game.removed);
  }

  private broadcast(game: Game, removed: string[] = []) {
    const now = this.now();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      try {
        if (removed.includes(attachment.playerID) || !game.player(attachment.playerID)) {
          ws.send(JSON.stringify({ type: 'closed', reason: 'removed' }));
          ws.close(4001, 'Removed from room');
        } else ws.send(JSON.stringify({ type: 'state', state: game.view(attachment.playerID, now, (cap) => mediaPath(game.state.code, cap)) }));
      } catch {
        // Socket already closing.
      }
    }
  }

  /** Tears the room down: all media, all storage, all sockets. */
  private async destroy() {
    const state = this.state;
    if (state) await this.deletePrefix(roomPrefix(state));
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: 'closed', reason: 'room-closed' }));
        ws.close(4000, 'Room closed');
      } catch {}
    }
    this.state = null;
    this.key = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    console.log(JSON.stringify({ event: 'room_closed' }));
  }

  private async deletePrefix(prefix: string) {
    let cursor: string | undefined;
    do {
      const page = await this.env.MEDIA.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length) await this.env.MEDIA.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  private async resolve(game: Game, identity: ForwardedIdentity) {
    if (identity.kind === 'clerk') {
      const p = game.playerForUser(identity.sub);
      if (!p) throw new GameError(403, 'Join this room first.');
      return { player: p, session: null };
    }
    if (identity.kind === 'room' && this.key) {
      const session = await verifySession(this.key, identity.token, game.state.code, game.state.instance, Math.floor(this.now() / 1000));
      const p = session && game.player(session.playerID);
      if (session && p) return { player: p, session };
    }
    throw new GameError(401, 'Your room session ended. Join again.');
  }

  private async session(state: RoomState, player: { id: string; nickname: string; kind: 'guest' | 'clerk' }) {
    return issueSession(this.key!, { code: state.code, instance: state.instance, playerID: player.id, nickname: player.nickname, kind: player.kind }, Math.floor(this.now() / 1000));
  }

  // ---- requests from the Worker ----

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const identity = JSON.parse(request.headers.get(IDENTITY_HEADER) ?? '{"kind":"anonymous"}') as ForwardedIdentity;
      const [, action, arg] = url.pathname.split('/');
      if (action === 'create' && request.method === 'POST') return await this.create(identity, await request.json());
      if (action === 'info' && request.method === 'GET') return this.info();
      if (action === 'join' && request.method === 'POST') return await this.join(identity, await request.json());
      if (action === 'ws') return await this.openSocket(request, identity);
      if (action === 'media' && request.method === 'POST') return await this.upload(request, identity);
      if (action === 'media' && request.method === 'DELETE' && arg) return await this.message(identity, { type: 'removeItem', itemID: arg });
      if (action === 'media' && request.method === 'GET' && arg) return await this.media(identity, arg);
      if (action === 'leave' && request.method === 'POST') return await this.message(identity, { type: 'leave' });
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof GameError || error instanceof MediaError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: 'room_error', type: error instanceof Error ? error.name : 'unknown' }));
      return json({ error: 'Something went wrong. Try again.' }, 500);
    }
  }

  private async create(identity: ForwardedIdentity, body: { code?: string; nickname?: unknown }) {
    if (this.state && this.state.phase !== 'closed') return json({ error: 'taken' }, 409);
    const code = String(body.code);
    const now = this.now();
    const state = newRoom(code, randomID(12), now);
    const game = new Game(state, this.random);
    const player = game.join(identity.kind === 'clerk' ? { kind: 'clerk', userID: identity.sub } : { kind: 'guest' }, body.nickname, now);
    this.key = newSessionKey();
    await this.ctx.storage.put('key', this.key);
    await this.commit(game);
    console.log(JSON.stringify({ event: 'room_created' }));
    return json({ code, playerID: player.id, nickname: player.nickname, ...(await this.session(state, player)) }, 201);
  }

  private info() {
    if (!this.state || this.state.phase === 'closed') return json({ error: 'That room does not exist or has closed.' }, 404);
    const s = this.game().state;
    return json({ code: s.code, phase: s.phase, players: s.players.length, capacity: CAPACITY, joinable: (s.phase === 'lobby' || s.phase === 'podium') && s.players.length < CAPACITY });
  }

  private async join(identity: ForwardedIdentity, body: { nickname?: unknown }) {
    const game = this.game();
    const player = game.join(identity.kind === 'clerk' ? { kind: 'clerk', userID: identity.sub } : { kind: 'guest' }, body.nickname, this.now());
    await this.commit(game);
    return json({ code: game.state.code, playerID: player.id, nickname: player.nickname, ...(await this.session(game.state, player)) });
  }

  private async openSocket(request: Request, identity: ForwardedIdentity) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426);
    const game = this.game();
    const { player, session } = await this.resolve(game, identity);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [player.id]);
    server.serializeAttachment({ playerID: player.id } satisfies Attachment);
    game.connect(player.id, this.now());
    // Long games: hand out a fresh room session before the old one runs out.
    if (session && session.expiresAt - Math.floor(this.now() / 1000) < SESSION_REFRESH_WINDOW_SECONDS)
      server.send(JSON.stringify({ type: 'session', ...(await this.session(game.state, player)) }));
    await this.commit(game);
    const offered = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((p) => p.trim()) ?? [];
    return new Response(null, { status: 101, webSocket: client, headers: offered.includes(WS_PROTOCOL) ? { 'Sec-WebSocket-Protocol': WS_PROTOCOL } : {} });
  }

  private async upload(request: Request, identity: ForwardedIdentity) {
    const game = this.game();
    const { player } = await this.resolve(game, identity);
    const kind = kindForContentType(request.headers.get('Content-Type'));
    game.assertCanAdd(player.id, kind);
    const raw = await readLimited(request, maxBytes(kind));
    const { bytes, durationMs } = validateMedia(kind, raw);
    const itemID = randomID(16);
    const key = `${roomPrefix(game.state)}g${game.state.game}/${itemID}`;
    const contentType = kind === 'photo' ? 'image/jpeg' : 'video/mp4';
    await this.env.MEDIA.put(key, bytes, { httpMetadata: { contentType } });
    // State may have moved on while the upload was in flight.
    const after = this.game();
    try {
      after.addItem(player.id, { id: itemID, kind, key, contentType, bytes: bytes.length, ...(durationMs ? { durationMs } : {}) }, this.now());
    } catch (error) {
      await this.env.MEDIA.delete(key);
      throw error;
    }
    await this.commit(after);
    return json({ item: { id: itemID, kind, durationMs: durationMs ?? null } }, 201);
  }

  private async media(identity: ForwardedIdentity, capability: string) {
    const game = this.game();
    await this.resolve(game, identity);
    const round = game.state.round;
    if (game.state.phase !== 'reveal' || !round || !timingSafeEqual(round.capability, capability)) return json({ error: 'This photo or video is no longer available.' }, 404);
    const item = game.state.items.find((i) => i.id === round.itemID);
    const object = item && (await this.env.MEDIA.get(item.key));
    if (!item || !object) return json({ error: 'This photo or video is no longer available.' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': item.contentType,
        'Content-Length': String(object.size),
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  /** Applies a client message on behalf of an identity (used by HTTP leave/delete too). */
  private async message(identity: ForwardedIdentity, message: ClientMessage) {
    const game = this.game();
    const { player } = await this.resolve(game, identity);
    apply(game, player.id, message, this.now());
    await this.commit(game);
    return json({ ok: true });
  }

  // ---- WebSocket events (hibernation API) ----

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    let message: ClientMessage;
    try {
      if (typeof raw !== 'string' || raw.length > 4096) throw 0;
      message = JSON.parse(raw);
      if (!message || typeof message.type !== 'string') throw 0;
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Could not read that message.' }));
      return;
    }
    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', serverNow: this.now() }));
      return;
    }
    try {
      const game = this.game();
      if (!attachment || !game.player(attachment.playerID)) throw new GameError(403, 'You are no longer in this room.');
      apply(game, attachment.playerID, message, this.now());
      await this.commit(game);
    } catch (error) {
      const text = error instanceof GameError ? error.message : 'Something went wrong. Try again.';
      if (!(error instanceof GameError)) console.error(JSON.stringify({ event: 'ws_error', type: error instanceof Error ? error.name : 'unknown' }));
      try {
        ws.send(JSON.stringify({ type: 'error', message: text, request: message.type }));
      } catch {}
    }
  }

  async webSocketClose(ws: WebSocket) {
    await this.dropSocket(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.dropSocket(ws);
  }

  private async dropSocket(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment || !this.state || this.state.phase === 'closed') return;
    const stillOpen = this.ctx.getWebSockets(attachment.playerID).some((other) => other !== ws && other.readyState === WebSocket.OPEN);
    if (stillOpen) return;
    const game = this.game();
    game.disconnect(attachment.playerID, this.now());
    await this.commit(game);
  }

  async alarm() {
    if (!this.state) return;
    await this.commit(this.game());
  }
}

export type ClientMessage =
  | { type: 'ready'; ready: boolean }
  | { type: 'settings'; rounds?: unknown; timerSeconds?: unknown; mediaMode?: unknown }
  | { type: 'start' }
  | { type: 'guess'; targetID: unknown }
  | { type: 'advance' }
  | { type: 'end' }
  | { type: 'playAgain' }
  | { type: 'removeItem'; itemID: string }
  | { type: 'leave' }
  | { type: 'ping' };

export function apply(game: Game, playerID: string, message: ClientMessage, now: number) {
  switch (message.type) {
    case 'ready':
      return game.setReady(playerID, message.ready === true, now);
    case 'settings':
      return game.updateSettings(playerID, { rounds: message.rounds, timerSeconds: message.timerSeconds, mediaMode: message.mediaMode }, now);
    case 'start':
      return game.start(playerID, now);
    case 'guess':
      return game.guess(playerID, message.targetID, now);
    case 'advance':
      return game.advance(playerID, now);
    case 'end':
      return game.end(playerID, now);
    case 'playAgain':
      return game.playAgain(playerID, now);
    case 'removeItem':
      return game.removeItem(playerID, String(message.itemID), now);
    case 'leave':
      return game.leave(playerID, now);
    default:
      throw new GameError(400, 'Unknown request.');
  }
}

async function readLimited(request: Request, limit: number) {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > limit) throw new MediaError(413, 'That file is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new MediaError(422, 'That file is empty.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new MediaError(413, 'That file is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
