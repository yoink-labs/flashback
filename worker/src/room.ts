// One Durable Object per room. It owns the room state, the room's session
// signing key, the WebSocket connections (hibernatable), and the one media item
// currently in play for each open slot. Media lives only in this object's memory:
// it is never written to storage, R2, or anywhere else. The Worker authenticates
// Clerk tokens and forwards requests here with an internal identity header; this
// object is not reachable from the internet.
import { DurableObject } from 'cloudflare:workers';
import { bunchFor } from './bunch';
import { CAPACITY, Game, GameError, newRoom, normalizeRoom, defaultRandomness, type Randomness, type RoomState, type Slot, type TurnRequest } from './game';
import { kindAllowed, kindForContentType, maxBytes, MediaError, validateMedia, type MediaKind, type MediaMode } from './media';
import { issueSession, newSessionKey, verifySession, SESSION_REFRESH_WINDOW_SECONDS } from './session';
import { randomID } from './codes';

export const IDENTITY_HEADER = 'x-flashback-identity';
export const WS_PROTOCOL = 'flashback.v2';

/** A socket may send this many messages per window; more than that is abuse, not play. */
export const MESSAGE_LIMIT = 60;
export const MESSAGE_WINDOW_MS = 10_000;

export type ForwardedIdentity = { kind: 'room'; token: string } | { kind: 'clerk'; sub: string } | { kind: 'anonymous' };

interface Attachment {
  playerID: string;
  /** Fixed-window message counter; kept in the attachment so it survives hibernation. */
  windowAt?: number;
  windowCount?: number;
}

/** The bytes for one open slot, kept in memory for this object's lifetime. */
interface StoredMedia {
  bytes: Uint8Array;
  kind: MediaKind;
  contentType: string;
  game: number;
  round: number;
}

interface FrameHeader {
  type: 'media';
  game: number;
  round: number;
  kind: MediaKind;
  contentType: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** The one place the `turn` message shape lives: only the slot's owner receives it. */
const turnMessage = (turn: { slot: string; game: number; round: number; mode: MediaMode; kind: MediaKind }) =>
  JSON.stringify({ type: 'turn', ...turn });

/** `[uint32 BE header length][UTF-8 JSON header][media bytes]`, server → client only. */
export function mediaFrame(header: FrameHeader, bytes: Uint8Array): ArrayBuffer {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + bytes.length);
  new DataView(out.buffer).setUint32(0, head.length, false);
  out.set(head, 4);
  out.set(bytes, 4 + head.length);
  return out.buffer;
}

export class Room extends DurableObject<Env> {
  private state: RoomState | null = null;
  private key: Uint8Array | null = null;
  /** The only copy of any round's media. Keyed by slot id. */
  private media = new Map<string, StoredMedia>();
  /** Overridable in tests for deterministic picks. */
  random: Randomness = defaultRandomness;
  /** Overridable in tests to move time forward. */
  now: () => number = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // Rooms persisted by an older build are normalized to the current shape.
      const stored = await ctx.storage.get<RoomState>('room');
      this.state = stored ? normalizeRoom(stored) : null;
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

  /** Persists state, frees media, schedules the alarm, and tells clients what changed. */
  private async commit(game: Game) {
    for (const slotID of game.freedSlots) this.media.delete(slotID);
    if (game.state.phase === 'closed') return this.destroy();
    this.state = game.state;
    await this.ctx.storage.put('room', game.state);
    const next = game.nextDeadline();
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
    this.broadcast(game, game.removed);
    for (const request of game.turnRequests) this.sendTurn(request);
  }

  /** Sends a frame, ignoring sockets that are already closing. */
  private send(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      ws.send(data);
    } catch {}
  }

  private broadcast(game: Game, removed: string[] = []) {
    const now = this.now();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      try {
        if (removed.includes(attachment.playerID) || !game.player(attachment.playerID)) {
          this.send(ws, JSON.stringify({ type: 'closed', reason: 'removed' }));
          ws.close(4001, 'Removed from room');
        } else this.send(ws, JSON.stringify({ type: 'state', state: game.view(attachment.playerID, now) }));
      } catch {
        // Socket already closing.
      }
    }
  }

  /** Tears the room down: all media, all storage, all sockets. */
  private async destroy() {
    this.media.clear();
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, JSON.stringify({ type: 'closed', reason: 'room-closed' }));
      try {
        ws.close(4000, 'Room closed');
      } catch {}
    }
    this.state = null;
    this.key = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    console.log(JSON.stringify({ event: 'room_closed' }));
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

  // ---- media frames ----

  private frameFor(media: StoredMedia) {
    return mediaFrame({ type: 'media', game: media.game, round: media.round, kind: media.kind, contentType: media.contentType }, media.bytes);
  }

  private sendTurn(request: TurnRequest) {
    const text = turnMessage(request);
    for (const ws of this.ctx.getWebSockets(request.playerID)) this.send(ws, text);
  }

  /** Sends a ready slot's bytes to every connected socket except its owner. */
  private sendMediaToOthers(slotID: string) {
    const media = this.media.get(slotID);
    const slot = this.state?.slots.find((sl) => sl.id === slotID);
    if (!media || !slot) return;
    const frame = this.frameFor(media);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment || attachment.playerID === slot.ownerID) continue;
      this.send(ws, frame);
    }
  }

  /** After a socket's first state message: re-send its turn and any media still held. */
  private sendMissed(ws: WebSocket, playerID: string, state: RoomState) {
    for (const slot of state.slots) {
      if (slot.status === 'requested' && slot.ownerID === playerID) this.sendTurnTo(ws, state, slot);
    }
    // Owners get their own item too: a client that restarted has lost its copy,
    // and showing "didn't load" only to the owner would give the owner away.
    for (const [slotID, media] of this.media) {
      if (media.game !== state.game) continue;
      const slot = state.slots.find((sl) => sl.id === slotID);
      if (!slot || slot.status !== 'ready') continue;
      this.send(ws, this.frameFor(media));
    }
  }

  private sendTurnTo(ws: WebSocket, state: RoomState, slot: Slot) {
    this.send(ws, turnMessage({ slot: slot.id, game: state.game, round: slot.round, mode: state.settings.mediaMode, kind: slot.requiredKind }));
  }

  // ---- requests from the Worker ----

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const identity = JSON.parse(request.headers.get(IDENTITY_HEADER) ?? '{"kind":"anonymous"}') as ForwardedIdentity;
      const [, action] = url.pathname.split('/');
      if (action === 'create' && request.method === 'POST') return await this.create(identity, await request.json());
      if (action === 'info' && request.method === 'GET') return this.info();
      if (action === 'join' && request.method === 'POST') return await this.join(identity, await request.json());
      if (action === 'ws') return await this.openSocket(request, identity);
      if (action === 'media' && request.method === 'POST') return await this.upload(request, identity, url.searchParams.get('slot'));
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
    const host = s.players.find((p) => p.id === s.hostID);
    return json({
      code: s.code,
      phase: s.phase,
      players: s.players.length,
      capacity: CAPACITY,
      joinable: (s.phase === 'lobby' || s.phase === 'podium') && s.players.length < CAPACITY,
      host: host?.nickname ?? null,
      settings: s.settings,
      bunch: bunchFor(s.settings.mediaMode, s.settings.evenSplit, s.settings.rounds, s.players.length),
    });
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
    // After the state message a client that reconnected gets its turn back and
    // every item still held in memory (including its own).
    if (this.state) this.sendMissed(server, player.id, this.state);
    const offered = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map((p) => p.trim()) ?? [];
    return new Response(null, { status: 101, webSocket: client, headers: offered.includes(WS_PROTOCOL) ? { 'Sec-WebSocket-Protocol': WS_PROTOCOL } : {} });
  }

  private async upload(request: Request, identity: ForwardedIdentity, slotID: string | null) {
    if (!slotID) return json({ error: 'Which turn?' }, 400);
    const game = this.game();
    const { player } = await this.resolve(game, identity);
    const slot = game.state.slots.find((sl) => sl.id === slotID);
    if (!slot || slot.status !== 'requested' || slot.ownerID !== player.id) throw new GameError(409, 'That turn has already ended.');
    const kind = kindForContentType(request.headers.get('Content-Type'));
    if (!kindAllowed(game.state.settings.mediaMode, kind))
      throw new MediaError(422, game.state.settings.mediaMode === 'photos' ? 'The host chose Photos only.' : 'The host chose Videos only.');
    // Reject the wrong kind before reading up to 8 MB of bytes; markReady checks
    // again on the fresh state in case the turn moved on meanwhile.
    if (kind !== slot.requiredKind) throw new GameError(422, slot.requiredKind === 'photo' ? 'This round needs a photo.' : 'This round needs a video.');
    const raw = await readLimited(request, maxBytes(kind));
    const { bytes } = validateMedia(kind, raw);
    const contentType = kind === 'photo' ? 'image/jpeg' : 'video/mp4';
    // State may have moved on while the upload was in flight (a timeout re-pick).
    const after = this.game();
    const ready = after.markReady(player.id, slotID, kind, this.now());
    this.media.set(slotID, { bytes, kind, contentType, game: after.state.game, round: ready.round });
    await this.commit(after);
    this.sendMediaToOthers(slotID);
    return json({ ok: true, kind, round: ready.round }, 201);
  }

  /** Applies a client message on behalf of an identity (used by HTTP leave too). */
  private async message(identity: ForwardedIdentity, message: ClientMessage) {
    const game = this.game();
    const { player } = await this.resolve(game, identity);
    apply(game, player.id, message, this.now());
    await this.commit(game);
    return json({ ok: true });
  }

  // ---- WebSocket events (hibernation API) ----

  /**
   * A fixed-window limit per socket. Every accepted message clones the room,
   * writes it to storage, and broadcasts it to everyone, so one client must not
   * be able to make the room do that in a loop (pause/resume or deck spam).
   */
  private allowMessage(ws: WebSocket, attachment: Attachment | null, now: number) {
    if (!attachment) return true;
    const started = attachment.windowAt;
    const within = started !== undefined && now >= started && now - started < MESSAGE_WINDOW_MS;
    const count = (within ? (attachment.windowCount ?? 0) : 0) + 1;
    if (count > MESSAGE_LIMIT) return false;
    ws.serializeAttachment({ ...attachment, windowAt: within ? started : now, windowCount: count } satisfies Attachment);
    return true;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    let message: ClientMessage;
    try {
      if (typeof raw !== 'string' || raw.length > 4096) throw 0;
      message = JSON.parse(raw);
      if (!message || typeof message.type !== 'string') throw 0;
    } catch {
      this.send(ws, JSON.stringify({ type: 'error', message: 'Could not read that message.' }));
      return;
    }
    const now = this.now();
    if (!this.allowMessage(ws, attachment, now)) {
      this.send(ws, JSON.stringify({ type: 'error', message: 'Slow down.', request: message.type }));
      return;
    }
    if (message.type === 'ping') {
      // The id lets a client pair each pong with its ping for clock sync (MILESTONE5 §2).
      const id = Number.isSafeInteger(message.id) ? message.id : undefined;
      this.send(ws, JSON.stringify({ type: 'pong', id, serverNow: now }));
      return;
    }
    try {
      const game = this.game();
      if (!attachment || !game.player(attachment.playerID)) throw new GameError(403, 'You are no longer in this room.');
      if (message.type === 'needMedia') {
        this.sendMediaForRound(ws, message.round);
        return;
      }
      apply(game, attachment.playerID, message, now);
      await this.commit(game);
    } catch (error) {
      const text = error instanceof GameError ? error.message : 'Something went wrong. Try again.';
      if (!(error instanceof GameError)) console.error(JSON.stringify({ event: 'ws_error', type: error instanceof Error ? error.name : 'unknown' }));
      this.send(ws, JSON.stringify({ type: 'error', message: text, request: message.type }));
    }
  }

  /** Re-sends a round's media if the bytes are still here, otherwise ignores it. */
  private sendMediaForRound(ws: WebSocket, round: unknown) {
    if (typeof round !== 'number' || !this.state) return;
    for (const [slotID, media] of this.media) {
      if (media.round !== round || media.game !== this.state.game) continue;
      const slot = this.state.slots.find((sl) => sl.id === slotID);
      if (!slot || slot.status !== 'ready') continue;
      this.send(ws, this.frameFor(media));
      return;
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
  | {
      type: 'settings';
      rounds?: unknown;
      timerSeconds?: unknown;
      mediaMode?: unknown;
      breakSeconds?: unknown;
      swaps?: unknown;
      evenSplit?: unknown;
      effects?: unknown;
      powerups?: unknown;
    }
  | { type: 'deck'; photos?: unknown; videos?: unknown }
  | { type: 'start' }
  | { type: 'guess'; targetID: unknown; elapsedMs?: unknown }
  | { type: 'hello'; caps?: unknown }
  | { type: 'mediaReady'; round?: unknown }
  | { type: 'useFiftyFifty' }
  | { type: 'buy'; item?: unknown }
  | { type: 'pass'; slot: string }
  | { type: 'needMedia'; round?: unknown }
  | { type: 'advance' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'end' }
  | { type: 'playAgain' }
  | { type: 'leave' }
  | { type: 'ping'; id?: unknown };

export function apply(game: Game, playerID: string, message: ClientMessage, now: number) {
  switch (message.type) {
    case 'ready':
      return game.setReady(playerID, message.ready === true, now);
    case 'settings':
      return game.updateSettings(
        playerID,
        {
          rounds: message.rounds,
          timerSeconds: message.timerSeconds,
          mediaMode: message.mediaMode,
          breakSeconds: message.breakSeconds,
          swaps: message.swaps,
          evenSplit: message.evenSplit,
          effects: message.effects,
          powerups: message.powerups,
        },
        now,
      );
    case 'deck':
      return game.setDeck(playerID, message.photos, message.videos, now);
    case 'start':
      return game.start(playerID, now);
    case 'guess':
      return game.guess(playerID, message.targetID, now, message.elapsedMs);
    case 'hello':
      return game.hello(playerID, message.caps);
    case 'mediaReady':
      return game.mediaReady(playerID, message.round, now);
    case 'useFiftyFifty':
      return game.useFiftyFifty(playerID, now);
    case 'buy':
      return game.buy(playerID, message.item, now);
    case 'pass':
      return game.pass(playerID, String(message.slot), now);
    case 'advance':
      return game.advance(playerID, now);
    case 'pause':
      return game.pause(playerID, now);
    case 'resume':
      return game.resume(playerID, now);
    case 'end':
      return game.end(playerID, now);
    case 'playAgain':
      return game.playAgain(playerID, now);
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
