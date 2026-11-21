// End-to-end through the Worker, the room Durable Object, and WebSockets. There
// is no R2 and no stored media: bytes travel as binary WebSocket frames and live
// only in the room's memory.
import { env, SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { useClerkKeysForTesting } from '../src/clerk';
import { COUNTDOWN_MS, HOST_GRACE_MS, UPLOAD_TIMEOUT_MS, type RoomView } from '../src/game';
import { defaultEffects } from '../src/effects';
import { MESSAGE_LIMIT, MESSAGE_WINDOW_MS, type Room } from '../src/room';
import { defaultSettings } from '../src/settings';
import { defaultPowerups } from '../src/shop';
import { clerkFixture, fakeJpeg, fakeMp4 } from './helpers';

const base = 'https://flashback.test';
afterEach(() => useClerkKeysForTesting(null));

interface Session {
  code: string;
  playerID: string;
  nickname: string;
  token: string;
  expiresAt: number;
  joinURL: string;
}

async function post(path: string, body: unknown, token?: string) {
  return SELF.fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function create(nickname: string, token?: string) {
  const res = await post('/v1/rooms', { nickname }, token);
  expect(res.status).toBe(201);
  return res.json<Session>();
}

async function join(code: string, nickname: string, token?: string) {
  const res = await post(`/v1/rooms/${code}/join`, { nickname }, token);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json<Session>();
}

type Message = {
  type: string;
  state?: RoomView;
  message?: string;
  reason?: string;
  request?: string;
  slot?: string;
  game?: number;
  round?: number;
  mode?: string;
  kind?: string;
  serverNow?: number;
};

type InboxEntry = { text: Message } | { binary: Uint8Array };
interface Waiter {
  match: (entry: InboxEntry) => boolean;
  resolve: (entry: InboxEntry) => void;
}

interface SocketHandle {
  ws: WebSocket;
  playerID: string;
  send(message: unknown): void;
  binaryReceived(): number;
  next(match?: (m: Message) => boolean): Promise<Message>;
  nextBinary(): Promise<Uint8Array>;
  tryNext(match: (m: Message) => boolean, ms?: number): Promise<Message | null>;
  state(match?: (s: RoomView) => boolean): Promise<RoomView>;
}

async function socket(code: string, token: string, playerID: string, viaHeader = false) {
  const headers: Record<string, string> = viaHeader
    ? { Upgrade: 'websocket', Authorization: `Bearer ${token}` }
    : { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `flashback.v2, auth.${token}` };
  const res = await SELF.fetch(`${base}/v1/rooms/${code}/ws`, { headers });
  expect(res.status).toBe(101);
  if (!viaHeader) expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('flashback.v2');
  const ws = res.webSocket!;
  ws.accept();

  let inbox: InboxEntry[] = [];
  const waiters: Waiter[] = [];
  let binaryCount = 0;

  const deliver = (entry: InboxEntry) => {
    const index = waiters.findIndex((waiter) => waiter.match(entry));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(entry);
    } else inbox.push(entry);
  };

  const toBytes = async (data: unknown): Promise<Uint8Array> => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    return new Uint8Array(0);
  };
  // Keep message order even though Blob conversion is asynchronous.
  let queue = Promise.resolve();
  ws.addEventListener('message', (event) => {
    const data = event.data;
    queue = queue.then(async () => {
      if (typeof data === 'string') deliver({ text: JSON.parse(data) as Message });
      else {
        binaryCount += 1;
        deliver({ binary: await toBytes(data) });
      }
    });
  });

  const take = (match: (entry: InboxEntry) => boolean, ms = 3000): Promise<InboxEntry> => {
    const index = inbox.findIndex(match);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = { match, resolve: (entry) => { if (timer) clearTimeout(timer); resolve(entry); } };
      timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error('timed out waiting for message'));
      }, ms);
      waiters.push(waiter);
    });
  };

  const tryTake = (match: (entry: InboxEntry) => boolean, ms = 200): Promise<InboxEntry | null> => {
    const index = inbox.findIndex(match);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = { match, resolve: (entry) => { if (timer) clearTimeout(timer); resolve(entry); } };
      timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, ms);
      waiters.push(waiter);
    });
  };

  const next = async (match: (m: Message) => boolean = () => true) => {
    const entry = await take((e) => 'text' in e && match(e.text));
    return (entry as { text: Message }).text;
  };

  const state = async (match: (s: RoomView) => boolean = () => true) => {
    const message = await next((m) => m.type === 'state' && match(m.state!));
    // Older snapshots are useless; binary frames and controls must be kept.
    inbox = inbox.filter((entry) => !('text' in entry) || entry.text.type !== 'state');
    return message.state!;
  };

  const handle: SocketHandle = {
    ws,
    playerID,
    send: (message) => ws.send(JSON.stringify(message)),
    binaryReceived: () => binaryCount,
    next,
    nextBinary: async () => {
      const entry = await take((e) => 'binary' in e);
      return (entry as { binary: Uint8Array }).binary;
    },
    tryNext: async (match, ms = 200) => {
      const entry = await tryTake((e) => 'text' in e && match(e.text), ms);
      return entry ? (entry as { text: Message }).text : null;
    },
    state,
  };
  return handle;
}

function parseFrame(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  return { header, payload: bytes.subarray(4 + length) };
}

async function upload(code: string, token: string, bytes: Uint8Array, type: string, slot: string) {
  return SELF.fetch(`${base}/v1/rooms/${code}/media?slot=${encodeURIComponent(slot)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
    body: bytes,
  });
}

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));

async function setClock(code: string, now: number) {
  await runInDurableObject(stub(code), (room: Room) => {
    room.now = () => now;
  });
}

/** Makes slot owners predictable: fewest-owned first, first in join order among ties. */
async function setDeterministicRandom(code: string) {
  await runInDurableObject(stub(code), (room: Room) => {
    let n = 0;
    room.random = { float: () => 0, id: () => String(++n).padStart(6, '0') + 'f'.repeat(26) };
  });
}

/** Gives everyone a full photo and video bunch and readies them up. */
async function readyAll(sockets: SocketHandle[]) {
  for (const socket of sockets) socket.send({ type: 'deck', photos: 12, videos: 6 });
  await sockets[0].state((s) => s.players.every((p) => p.deck.photos === 12 && p.deck.videos === 6));
  for (const socket of sockets) socket.send({ type: 'ready', ready: true });
  await sockets[0].state((s) => s.players.every((p) => p.ready));
}

/** Waits on every socket for a matching turn and returns the ones that got one. */
async function turnsOn(sockets: SocketHandle[], match: (m: Message) => boolean, ms = 400) {
  const found = await Promise.all(sockets.map(async (socket) => ({ socket, turn: await socket.tryNext(match, ms) })));
  return found.filter((entry): entry is { socket: SocketHandle; turn: Message } => entry.turn !== null);
}

describe('rooms over HTTP', () => {
  it('creates a guest room with a share link, a room-scoped session, host, and settings', async () => {
    const host = await create('Host');
    expect(host.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
    expect(host.joinURL).toBe(`https://flashback.yoinklabs.dev/join/${host.code}`);
    expect(host.token.split('.')).toHaveLength(3);
    const info = await (await SELF.fetch(`${base}/v1/rooms/${host.code.toLowerCase()}`)).json();
    expect(info).toEqual({
      code: host.code,
      phase: 'lobby',
      players: 1,
      capacity: 12,
      joinable: true,
      host: 'Host',
      settings: defaultSettings(),
      bunch: { photos: 12, videos: 6 },
    });
  });

  it('rejects bad nicknames, duplicates, unknown rooms, and bad codes clearly', async () => {
    const host = await create('Host');
    expect((await post('/v1/rooms', { nickname: '  ' })).status).toBe(422);
    const dup = await post(`/v1/rooms/${host.code}/join`, { nickname: 'HOST' });
    expect(dup.status).toBe(422);
    expect((await dup.json<{ error: string }>()).error).toMatch(/already in this room/);
    expect((await post('/v1/rooms/ZZZZZZ/join', { nickname: 'Sam' })).status).toBe(404);
    expect((await post('/v1/rooms/ABC1O0/join', { nickname: 'Sam' })).status).toBe(404);
  });

  it('accepts optional Clerk sign-in for create and join, and rejects bad Clerk tokens', async () => {
    const clerk = await clerkFixture();
    useClerkKeysForTesting(clerk.jwks);
    const signedIn = await create('Signed', await clerk.sign({ azp: 'https://flashback.yoinklabs.dev' }, { sub: 'user_a' }));
    expect(signedIn.playerID).toMatch(/^u_/);
    const guest = await join(signedIn.code, 'Guest');
    expect(guest.playerID).toMatch(/^g_/);
    const expired = await post(`/v1/rooms/${signedIn.code}/join`, { nickname: 'Late' }, await clerk.sign({}, { expiresIn: '-1m', sub: 'user_b' }));
    expect(expired.status).toBe(401);
    // A room token is not a way to join another room.
    expect((await post(`/v1/rooms/${signedIn.code}/join`, { nickname: 'Sneaky' }, guest.token)).status).toBe(401);
  });

  it('requires auth for sockets and uploads, and room tokens only work in their room', async () => {
    const a = await create('A');
    const b = await create('B');
    expect((await SELF.fetch(`${base}/v1/rooms/${a.code}/ws`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
    const cross = await SELF.fetch(`${base}/v1/rooms/${a.code}/ws`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `flashback.v2, auth.${b.token}` } });
    expect(cross.status).toBe(401);
    expect((await upload(a.code, b.token, fakeJpeg(), 'image/jpeg', 'abc')).status).toBe(401);
    expect((await upload(a.code, 'garbage', fakeJpeg(), 'image/jpeg', 'abc')).status).toBe(401);
    // The turn to upload for is required.
    expect((await SELF.fetch(`${base}/v1/rooms/${a.code}/media`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'image/jpeg' }, body: fakeJpeg() })).status).toBe(400);
    // The M1 media routes are gone.
    expect((await SELF.fetch(`${base}/v1/rooms/${a.code}/media/abcdef`, { headers: { Authorization: `Bearer ${a.token}` } })).status).toBe(404);
    expect((await SELF.fetch(`${base}/v1/rooms/${a.code}/media/abcdef`, { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}` } })).status).toBe(404);
  });

  it('offers flashback.v2 and refuses a v1-only client cleanly', async () => {
    const host = await create('Host');
    const v1 = await SELF.fetch(`${base}/v1/rooms/${host.code}/ws`, {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `flashback.v1, auth.${host.token}` },
    });
    expect(v1.status).toBe(101);
    expect(v1.headers.get('Sec-WebSocket-Protocol')).not.toBe('flashback.v2');
    v1.webSocket?.accept();
    v1.webSocket?.close();
  });
});

describe('a full game over WebSockets with guests and a Clerk player', () => {
  it('uploads on turn, pushes binary frames, lets everyone guess, and stores nothing', async () => {
    const clerk = await clerkFixture();
    useClerkKeysForTesting(clerk.jwks);
    const clerkToken = await clerk.sign({ azp: 'com.yoinklabs.flashback' }, { sub: 'user_clerk' });

    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const cal = await join(host.code, 'Cal', clerkToken);
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);
    // Host owns round 1 and Bea owns round 2, so Cal (not the host) can be the
    // player who reconnects without the host role moving.
    await setDeterministicRandom(code);
    const tokenOf = new Map([host, bea, cal].map((session) => [session.playerID, session.token]));

    const hostWS = await socket(code, host.token, host.playerID);
    const beaWS = await socket(code, bea.token, bea.playerID, true);
    // The signed-in player connects with their Clerk token directly.
    const calWS = await socket(code, clerkToken, cal.playerID);
    const sockets = [hostWS, beaWS, calWS];
    // The live socket per player: a reconnecting player replaces their old one.
    const live = new Map(sockets.map((handle) => [handle.playerID, handle]));

    const lobby = await hostWS.state((s) => s.players.every((p) => p.connected));
    expect(lobby.players.map((p) => [p.nickname, p.isHost, p.signedIn])).toEqual([
      ['Host', true, false],
      ['Bea', false, false],
      ['Cal', false, true],
    ]);
    expect(lobby.startBlocker).toBe('Deal 12 photos and 6 videos');

    // Decks are reported over the socket and shown to everyone; no upload happens yet.
    for (const socket of sockets) socket.send({ type: 'deck', photos: 12, videos: 6 });
    const decked = await hostWS.state((s) => s.players.every((p) => p.deck.photos === 12 && p.deck.videos === 6));
    expect(decked.players.every((p) => !('photos' in p) && !('videos' in p))).toBe(true);
    expect(decked.players.map((p) => p.deck)).toEqual([
      { photos: 12, videos: 6 },
      { photos: 12, videos: 6 },
      { photos: 12, videos: 6 },
    ]);

    hostWS.send({ type: 'settings', rounds: 2, timerSeconds: 20, mediaMode: 'photos' });
    await hostWS.state((s) => s.settings.rounds === 2);
    beaWS.send({ type: 'settings', rounds: 5 });
    expect((await beaWS.next((m) => m.type === 'error')).message).toMatch(/Only the host/);

    for (const socket of sockets) socket.send({ type: 'ready', ready: true });
    const ready = await hostWS.state((s) => s.players.every((p) => p.ready));
    expect(ready.startBlocker).toBeNull();

    hostWS.send({ type: 'start' });
    const countdown = await beaWS.state((s) => s.phase === 'countdown');
    expect(countdown.round).toEqual({ index: 1, total: 2, waiting: true });
    expect(countdown.phaseEndsAt).toBeNull();

    // Two slots, two different owners, and only those owners are asked.
    const startedTurns = await turnsOn(sockets, (m) => m.type === 'turn');
    expect(startedTurns).toHaveLength(2);
    const round1 = startedTurns.find((entry) => entry.turn.round === 1)!;
    const round2 = startedTurns.find((entry) => entry.turn.round === 2)!;
    expect(round1.socket.playerID).not.toBe(round2.socket.playerID);
    expect(round1.turn).toMatchObject({ game: 1, round: 1, mode: 'photos', kind: 'photo' });
    expect(round2.turn).toMatchObject({ game: 1, round: 2, mode: 'photos', kind: 'photo' });
    expect(round1.turn.slot).not.toBe(round2.turn.slot);

    const owner1Token = tokenOf.get(round1.socket.playerID)!;
    const someoneElse = sockets.find((socket) => socket.playerID !== round1.socket.playerID)!;
    // Only the slot's owner may upload for it, and only while it is requested.
    expect((await upload(code, tokenOf.get(someoneElse.playerID)!, fakeJpeg(), 'image/jpeg', round1.turn.slot!)).status).toBe(409);
    expect((await upload(code, owner1Token, fakeJpeg(), 'image/jpeg', 'not-a-slot')).status).toBe(409);
    expect((await upload(code, owner1Token, fakeJpeg(), 'image/heic', round1.turn.slot!)).status).toBe(415);

    const uploaded = await upload(code, owner1Token, fakeJpeg(), 'image/jpeg', round1.turn.slot!);
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    await uploaded.text();
    // The turn is spent.
    expect((await upload(code, owner1Token, fakeJpeg(), 'image/jpeg', round1.turn.slot!)).status).toBe(409);

    // Every other connected socket gets the item as one binary frame; the owner does not.
    const others = sockets.filter((socket) => socket.playerID !== round1.socket.playerID);
    const frames = await Promise.all(others.map((socket) => socket.nextBinary()));
    expect(round1.socket.binaryReceived()).toBe(0);
    for (const frame of frames.map(parseFrame)) {
      expect(frame.header).toEqual({ type: 'media', game: 1, round: 1, kind: 'photo', contentType: 'image/jpeg' });
      expect(frame.payload.length).toBeGreaterThan(0);
      expect(new TextDecoder('latin1').decode(frame.payload)).not.toContain('GPSLatitude');
    }

    // The countdown waits for the upload, then settles; it is no longer waiting.
    const settled = await hostWS.state((s) => s.phase === 'countdown' && s.round !== null && 'waiting' in s.round && s.round.waiting === false);
    expect(settled.phaseEndsAt).toBe(t0 + COUNTDOWN_MS);

    await setClock(code, t0 + COUNTDOWN_MS);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    const views = await Promise.all(sockets.map((socket) => socket.state((s) => s.phase === 'reveal')));
    const ownerIndex = sockets.findIndex((socket) => socket.playerID === round1.socket.playerID);
    const ownerView = views[ownerIndex];
    const otherView = views.find((_, i) => i !== ownerIndex)!;
    // Nobody can tell the owner from the reveal view.
    expect({ ...ownerView, you: null }).toEqual({ ...otherView, you: null });
    expect(JSON.stringify(ownerView)).not.toMatch(/ownerID|isYours|mediaPath|"slot"/);
    expect(ownerView.round).toMatchObject({ index: 1, total: 2, kind: 'photo', canGuess: true, guessedCount: 0, guesserCount: 3 });

    // Reconnecting during a ready slot re-sends the media frame after the state.
    const owners = new Set([round1.socket.playerID, round2.socket.playerID]);
    const bystander = sockets.find((socket) => !owners.has(socket.playerID))!;
    bystander.ws.close(1000);
    const reconnected = await socket(code, tokenOf.get(bystander.playerID)!, bystander.playerID);
    live.set(bystander.playerID, reconnected);
    await reconnected.state((s) => s.phase === 'reveal');
    const reframe = parseFrame(await reconnected.nextBinary());
    expect(reframe.header).toMatchObject({ type: 'media', game: 1, round: 1, kind: 'photo' });

    // A second socket for the round-2 owner gets its turn again and the missed media.
    const extra = await socket(code, tokenOf.get(round2.socket.playerID)!, round2.socket.playerID);
    await extra.state((s) => s.phase === 'reveal');
    const resentTurn = await extra.tryNext((m) => m.type === 'turn' && m.round === 2, 1000);
    expect(resentTurn?.slot).toBe(round2.turn.slot);
    const extraFrame = parseFrame(await extra.nextBinary());
    expect(extraFrame.header).toMatchObject({ type: 'media', game: 1, round: 1 });

    // The round-1 owner reconnecting gets its own item back too, so a restarted
    // owner never sees a "didn't load" screen that would give it away.
    const ownerAgain = await socket(code, tokenOf.get(round1.socket.playerID)!, round1.socket.playerID);
    await ownerAgain.state((s) => s.phase === 'reveal');
    expect(parseFrame(await ownerAgain.nextBinary()).header).toMatchObject({ type: 'media', game: 1, round: 1 });

    // The owner guesses too (themself) so nobody can tell, but it is a 0-point decoy.
    const ownerID = round1.socket.playerID;
    const [a, b] = sockets.map((socket) => socket.playerID).filter((id) => id !== ownerID);
    live.get(ownerID)!.send({ type: 'guess', targetID: ownerID });
    await live.get(host.playerID)!.state((s) => s.phase === 'reveal' && s.round !== null && 'guessedCount' in s.round && s.round.guessedCount === 1);
    await setClock(code, t0 + COUNTDOWN_MS + 5_000);
    live.get(a)!.send({ type: 'guess', targetID: ownerID });
    live.get(b)!.send({ type: 'guess', targetID: a });

    const results = await live.get(host.playerID)!.state((s) => s.phase === 'results');
    expect(results.lastResult!.ownerID).toBe(ownerID);
    const rows = Object.fromEntries(results.lastResult!.rows.map((row) => [row.playerID, row]));
    expect(rows[ownerID]).toMatchObject({ correct: true, points: 0, targetID: ownerID });
    expect(rows[a]).toMatchObject({ correct: true, points: 875 });
    expect(rows[b]).toMatchObject({ correct: false, points: 0 });

    // Nothing was ever written but the room state and its session key.
    const keys = await runInDurableObject(stub(code), async (_room, state) => [...(await state.storage.list()).keys()]);
    expect(keys.sort()).toEqual(['key', 'room']);

    // Host ends the game; the fastest correct non-owner wins.
    live.get(host.playerID)!.send({ type: 'end' });
    const podium = await live.get(host.playerID)!.state((s) => s.phase === 'podium');
    expect(podium.podium[0]).toMatchObject({ playerID: a, rank: 1, score: 875 });

    // Play again in the same room: guest and Clerk sessions still work.
    live.get(host.playerID)!.send({ type: 'playAgain' });
    const again = await live.get(cal.playerID)!.state((s) => s.phase === 'lobby' && s.game === 2);
    expect(again.players).toHaveLength(3);
    expect(again.settings).toEqual({ ...defaultSettings(), rounds: 2, timerSeconds: 20, mediaMode: 'photos' });
    // There is no lobby upload path any more.
    expect((await upload(code, host.token, fakeJpeg(), 'image/jpeg', round1.turn.slot!)).status).toBe(409);
    for (const handle of [...sockets, reconnected, extra, ownerAgain]) handle.ws.close(1000);
  });

  it('re-picks a requested slot when its owner passes, and gives up when everyone has', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const cal = await join(host.code, 'Cal');
    const code = host.code;
    await setClock(code, Date.now());
    const sessions = [host, bea, cal];
    const sockets = await Promise.all(sessions.map((session) => socket(code, session.token, session.playerID)));
    await readyAll(sockets);

    sockets[0].send({ type: 'start' });
    await sockets[0].state((s) => s.phase === 'countdown');
    const first = (await turnsOn(sockets, (m) => m.type === 'turn' && m.round === 1))[0];
    expect(first).toBeDefined();

    let current = first;
    for (let pass = 0; pass < 3; pass++) {
      const previousOwner = current.socket.playerID;
      current.socket.send({ type: 'pass', slot: current.turn.slot });
      if (pass === 2) break; // nobody is left to ask
      const next = (await turnsOn(sockets, (m) => m.type === 'turn' && m.round === 1, 500))[0];
      expect(next, `pass ${pass + 1} should re-pick`).toBeDefined();
      expect(next.turn.slot).toBe(current.turn.slot);
      expect(next.socket.playerID).not.toBe(previousOwner);
      current = next;
    }
    const podium = await sockets[0].state((s) => s.phase === 'podium');
    expect(podium.podium.length).toBe(3);
    for (const handle of sockets) handle.ws.close(1000);
  });

  it('re-picks a requested slot when its owner times out', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const cal = await join(host.code, 'Cal');
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);
    const sessions = [host, bea, cal];
    const sockets = await Promise.all(sessions.map((session) => socket(code, session.token, session.playerID)));
    await readyAll(sockets);

    sockets[0].send({ type: 'start' });
    await sockets[0].state((s) => s.phase === 'countdown');
    const first = (await turnsOn(sockets, (m) => m.type === 'turn' && m.round === 1))[0];
    expect(first).toBeDefined();

    await setClock(code, t0 + UPLOAD_TIMEOUT_MS);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    const repicked = (await turnsOn(sockets, (m) => m.type === 'turn' && m.round === 1, 500))[0];
    expect(repicked).toBeDefined();
    expect(repicked.turn.slot).toBe(first.turn.slot);
    expect(repicked.socket.playerID).not.toBe(first.socket.playerID);

    // Still waiting for an upload for round 1.
    const state = await sockets[0].state((s) => s.phase === 'countdown');
    expect(state.round).toMatchObject({ index: 1, waiting: true });
    for (const handle of sockets) handle.ws.close(1000);
  });

  it('rejects an upload of the wrong kind for the round', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const code = host.code;
    await setClock(code, Date.now());
    await setDeterministicRandom(code);
    const sessions = [host, bea];
    const sockets = await Promise.all(sessions.map((session) => socket(code, session.token, session.playerID)));
    const tokenOf = new Map(sessions.map((session) => [session.playerID, session.token]));
    await readyAll(sockets);

    sockets[0].send({ type: 'start' });
    await sockets[0].state((s) => s.phase === 'countdown');
    const turn = (await turnsOn(sockets, (m) => m.type === 'turn' && m.round === 1))[0];
    expect(turn).toBeDefined();
    const token = tokenOf.get(turn.socket.playerID)!;
    expect(turn.turn.kind).toMatch(/photo|video/);
    const photo = turn.turn.kind === 'photo';

    const rejected = await upload(code, token, photo ? fakeMp4() : fakeJpeg(), photo ? 'video/mp4' : 'image/jpeg', turn.turn.slot!);
    expect(rejected.status).toBe(422);
    expect((await rejected.json<{ error: string }>()).error).toMatch(photo ? /needs a photo/ : /needs a video/);

    // The round's own kind still lands on the same turn.
    expect((await upload(code, token, photo ? fakeJpeg() : fakeMp4(), photo ? 'image/jpeg' : 'video/mp4', turn.turn.slot!)).status).toBe(201);
    for (const handle of sockets) handle.ws.close(1000);
  });

  it('wires settings, pause, and resume over the socket (host only)', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);
    await setDeterministicRandom(code);
    const sessions = [host, bea];
    const sockets = await Promise.all(sessions.map((session) => socket(code, session.token, session.playerID)));
    const tokenOf = new Map(sessions.map((session) => [session.playerID, session.token]));
    await readyAll(sockets);

    // The new settings keys travel over the socket and are validated like the rest.
    sockets[0].send({ type: 'settings', mediaMode: 'photos', breakSeconds: 5, swaps: 4 });
    const configured = await sockets[0].state((s) => s.settings.breakSeconds === 5 && s.settings.swaps === 4);
    expect(configured.settings).toEqual({ ...defaultSettings(), mediaMode: 'photos', breakSeconds: 5, swaps: 4 });
    sockets[0].send({ type: 'settings', breakSeconds: 2 });
    expect((await sockets[0].next((m) => m.type === 'error' && m.request === 'settings')).message).toMatch(/Break must be 3–30/);
    sockets[0].send({ type: 'settings', swaps: 11 });
    expect((await sockets[0].next((m) => m.type === 'error' && m.request === 'settings')).message).toMatch(/Swaps must be 0–10/);

    sockets[0].send({ type: 'start' });
    await sockets[0].state((s) => s.phase === 'countdown');
    const turn = (await turnsOn(sockets, (m) => m.type === 'turn' && m.round === 1))[0];
    expect(turn).toBeDefined();
    expect(turn.turn.kind).toBe('photo');
    expect((await upload(code, tokenOf.get(turn.socket.playerID)!, fakeJpeg(), 'image/jpeg', turn.turn.slot!)).status).toBe(201);
    await sockets[0].state((s) => s.phase === 'countdown' && s.round !== null && 'waiting' in s.round && s.round.waiting === false);

    await setClock(code, t0 + COUNTDOWN_MS);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    const reveal = await sockets[0].state((s) => s.phase === 'reveal' && s.paused === false);
    expect(reveal.pausedRemainingMs).toBeNull();

    // Guests cannot pause.
    sockets[1].send({ type: 'pause' });
    expect((await sockets[1].next((m) => m.type === 'error' && m.request === 'pause')).message).toMatch(/Only the host/);

    const pausedAt = t0 + COUNTDOWN_MS + 1_000;
    await setClock(code, pausedAt);
    sockets[0].send({ type: 'pause' });
    const paused = await sockets[1].state((s) => s.paused);
    expect(paused).toMatchObject({ phase: 'reveal', phaseEndsAt: null, paused: true, pausedRemainingMs: 20_000 - 1_000 });

    sockets[1].send({ type: 'guess', targetID: host.playerID });
    expect((await sockets[1].next((m) => m.type === 'error' && m.request === 'guess')).message).toBe('The game is paused.');

    await setClock(code, pausedAt + 60_000);
    sockets[0].send({ type: 'resume' });
    const resumed = await sockets[1].state((s) => s.phaseEndsAt === t0 + COUNTDOWN_MS + 20_000 + 60_000);
    expect(resumed.paused).toBe(false);
    expect(resumed.pausedRemainingMs).toBeNull();

    // Ending the game while paused still works and clears the pause.
    sockets[0].send({ type: 'end' });
    const podium = await sockets[0].state((s) => s.phase === 'podium');
    expect(podium.paused).toBe(false);
    expect(podium.pausedRemainingMs).toBeNull();
    for (const handle of sockets) handle.ws.close(1000);
  });

  it('transfers host on disconnect and tears down empty rooms without stored media', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);
    const hostWS = await socket(code, host.token, host.playerID);
    const beaWS = await socket(code, bea.token, bea.playerID);
    await beaWS.state((s) => s.players.every((p) => p.connected));

    hostWS.ws.close(1000);
    // A dropped host keeps the role for HOST_GRACE_MS (app switch), then it moves on.
    await beaWS.state((s) => !s.players.find((p) => p.id === host.playerID)!.connected && s.hostID === host.playerID);
    await setClock(code, t0 + HOST_GRACE_MS);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    const transferred = await beaWS.state((s) => s.hostID === bea.playerID);
    expect(transferred.players.find((p) => p.id === host.playerID)!.connected).toBe(false);

    // Leaving over HTTP removes the player.
    const left = await SELF.fetch(`${base}/v1/rooms/${code}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${bea.token}` } });
    expect(left.status).toBe(200);
    expect((await beaWS.next((m) => m.type === 'closed')).reason).toBe('removed');
    expect((await upload(code, bea.token, fakeJpeg(), 'image/jpeg', 'abc')).status).toBe(401);

    // Nobody is connected: after the grace period the room is gone and empty.
    await setClock(code, t0 + 4 * 60_000);
    await runDurableObjectAlarm(stub(code));
    expect((await SELF.fetch(`${base}/v1/rooms/${code}`)).status).toBe(404);
    expect((await post(`/v1/rooms/${code}/join`, { nickname: 'Again' })).status).toBe(404);
  });
});

describe('misc', () => {
  it('rate-limits a socket that floods the room with messages', async () => {
    const host = await create('Host');
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);
    const hostWS = await socket(code, host.token, host.playerID);
    await hostWS.state((s) => s.players.length === 1);

    for (let i = 0; i < MESSAGE_LIMIT; i++) hostWS.send({ type: 'deck', photos: 1, videos: 1 });
    await hostWS.state((s) => s.players[0].deck.photos === 1);
    hostWS.send({ type: 'deck', photos: 2, videos: 2 });
    expect((await hostWS.next((m) => m.type === 'error' && m.request === 'deck')).message).toMatch(/Slow down/);

    // The dropped message was never applied; the next window accepts it.
    await setClock(code, t0 + MESSAGE_WINDOW_MS);
    hostWS.send({ type: 'deck', photos: 2, videos: 2 });
    await hostWS.state((s) => s.players[0].deck.photos === 2);
    hostWS.ws.close(1000);
  });

  it('serves health and the app-site association', async () => {
    expect(await (await SELF.fetch(`${base}/health`)).json()).toEqual({ service: 'flashback', status: 'ok' });
    const aasa = await (await SELF.fetch(`${base}/.well-known/apple-app-site-association`)).json<{ applinks: { details: { appIDs: string[] }[] } }>();
    expect(aasa.applinks.details[0].appIDs).toEqual(['64PUT29XZ8.com.yoinklabs.flashback']);
  });

  it('rejects video uploads that are too long or not H.264, then accepts a valid clip', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const code = host.code;
    await setClock(code, Date.now());
    const sockets = [await socket(code, host.token, host.playerID), await socket(code, bea.token, bea.playerID)];
    sockets[0].send({ type: 'settings', mediaMode: 'videos' });
    await sockets[0].state((s) => s.settings.mediaMode === 'videos');
    for (const socket of sockets) socket.send({ type: 'deck', photos: 0, videos: 6 });
    await sockets[0].state((s) => s.players.every((p) => p.deck.videos === 6));
    for (const socket of sockets) socket.send({ type: 'ready', ready: true });
    await sockets[0].state((s) => s.players.every((p) => p.ready));
    sockets[0].send({ type: 'start' });
    await sockets[0].state((s) => s.phase === 'countdown');
    const turn = (await turnsOn(sockets, (m) => m.type === 'turn' && m.round === 1))[0];
    expect(turn.turn.kind).toBe('video');
    const token = new Map([[host.playerID, host.token], [bea.playerID, bea.token]]).get(turn.socket.playerID)!;

    expect((await upload(code, token, fakeMp4({ durationMs: 20_000 }), 'video/mp4', turn.turn.slot!)).status).toBe(422);
    expect((await upload(code, token, fakeMp4({ codec: 'hvc1' }), 'video/mp4', turn.turn.slot!)).status).toBe(422);
    expect((await upload(code, token, fakeMp4({ durationMs: 6_000 }), 'video/mp4', turn.turn.slot!)).status).toBe(201);
    for (const handle of sockets) handle.ws.close(1000);
  });
});

describe('Milestone 4 over the socket', () => {
  it('wires Even Split, effects, power-ups, the shop and 50/50 end to end', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const cal = await join(host.code, 'Cal');
    const dee = await join(host.code, 'Dee');
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);
    await setDeterministicRandom(code);
    const sessions = [host, bea, cal, dee];
    const sockets = await Promise.all(sessions.map((session) => socket(code, session.token, session.playerID)));
    const tokenOf = new Map(sessions.map((session) => [session.playerID, session.token]));
    const [hostWS, beaWS] = sockets;

    const effects = {
      ...defaultEffects(),
      greyscale: { enabled: true, trigger: 'right' as const, after: 3 },
      blur: { enabled: true, trigger: 'right' as const, after: 5, strength: 'medium' as const },
    };
    const powerups = { fiftyFifty: { enabled: true, after: 3 }, shop: { enabled: true } };
    hostWS.send({ type: 'settings', rounds: 4, mediaMode: 'photos', evenSplit: true, effects, powerups, breakSeconds: 5 });
    const configured = await hostWS.state((s) => s.settings.rounds === 4 && s.settings.evenSplit);
    expect(configured.settings.effects).toEqual(effects);
    expect(configured.settings.powerups).toEqual(powerups);
    // 4 rounds across 4 players: one photo each.
    expect(configured.bunch).toEqual({ photos: 1, videos: 0 });

    // The join preview carries the same settings and requirement.
    const info = await (await SELF.fetch(`${base}/v1/rooms/${code}`)).json<{ settings: Record<string, unknown>; bunch: unknown }>();
    expect(info.bunch).toEqual({ photos: 1, videos: 0 });
    expect(info.settings).toMatchObject({ rounds: 4, evenSplit: true, effects, powerups });

    // A bad effect pairing is refused with the contract's message.
    hostWS.send({ type: 'settings', effects: { ...effects, blur: { ...effects.blur, after: 3 } } });
    expect((await hostWS.next((m) => m.type === 'error' && m.request === 'settings')).message).toBe('Blur has to start after greyscale.');

    await readyAll(sockets);
    hostWS.send({ type: 'start' });
    await hostWS.state((s) => s.phase === 'countdown');
    const startedTurns = await turnsOn(sockets, (m) => m.type === 'turn');
    expect(startedTurns).toHaveLength(2);
    // Every slot's owner can upload during the countdown's lookahead.
    for (const turn of startedTurns) {
      const uploaded = await upload(code, tokenOf.get(turn.socket.playerID)!, fakeJpeg(), 'image/jpeg', turn.turn.slot!);
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    }
    await hostWS.state((s) => s.phase === 'countdown' && s.round !== null && 'waiting' in s.round && s.round.waiting === false);

    const round1 = startedTurns.find((turn) => turn.turn.round === 1)!;
    const owner1 = round1.socket.playerID;
    await setClock(code, t0 + COUNTDOWN_MS);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    await beaWS.state((s) => s.phase === 'reveal' && s.round !== null && 'index' in s.round && s.round.index === 1);

    // Everyone guesses the round-1 owner, including the owner's decoy.
    for (const handle of sockets) handle.send({ type: 'guess', targetID: owner1 });
    const results = await hostWS.state((s) => s.phase === 'results');
    expect(results.lastResult!.ownerID).toBe(owner1);
    expect(results.shop).toEqual({ open: true, bought: false, prices: { doubleDown: 250, shield: 200, fiftyFifty: 400 } });

    // The 50/50 and the shop are wired over the socket. The buyer guessed
    // round 1 right (anyone but its owner), so they can afford one.
    const buyerWS = sockets.find((handle) => handle.playerID !== owner1)!;
    const buyerID = buyerWS.playerID;
    buyerWS.send({ type: 'buy', item: 'fiftyFifty' });
    const bought = await buyerWS.state((s) => s.shop !== null && (s.shop as { bought: boolean }).bought);
    expect(bought.shop).toMatchObject({ open: true, bought: true });
    const buyer = bought.players.find((p) => p.id === buyerID)!;
    expect(buyer.items).toEqual({ doubleDown: 0, shield: 0, fiftyFifty: 1 });
    expect(buyer.score).toBe(600); // 1000 for an instant correct guess, minus 400.
    buyerWS.send({ type: 'buy', item: 'shield' });
    expect((await buyerWS.next((m) => m.type === 'error' && m.request === 'buy')).message).toBe('One buy per break.');

    // Leave the break, then reveal round 2 (its slot was uploaded already).
    await setClock(code, results.phaseEndsAt!);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    const countdown2 = await hostWS.state((s) => s.phase === 'countdown' && s.round !== null && 'index' in s.round && s.round.index === 2);
    await setClock(code, countdown2.phaseEndsAt!);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    await hostWS.state((s) => s.phase === 'reveal' && s.round !== null && 'index' in s.round && s.round.index === 2);

    buyerWS.send({ type: 'useFiftyFifty' });
    const used = await buyerWS.state((s) => {
      const round = s.round as { eliminated?: string[] } | null;
      return s.phase === 'reveal' && Array.isArray(round?.eliminated) && round.eliminated.length === 1;
    });
    const eliminated = (used.round as unknown as { eliminated: string[] }).eliminated;
    expect(new Set(eliminated).size).toBe(1);
    expect(used.players.find((p) => p.id === buyerID)!.items.fiftyFifty).toBe(0);
    // Another viewer's state has no eliminations of its own.
    const hostAfterUse = await sockets.find((handle) => handle.playerID !== buyerID)!.state((s) => s.players.find((p) => p.id === buyerID)!.items.fiftyFifty === 0);
    expect((hostAfterUse.round as unknown as { eliminated: string[] }).eliminated).toEqual([]);
    expect(eliminated).not.toContain(buyerID);
    const round2Owner = startedTurns.find((turn) => turn.turn.round === 2)!.socket.playerID;
    expect(eliminated).not.toContain(round2Owner);
    // Guessing a player the 50/50 ruled out is refused.
    buyerWS.send({ type: 'guess', targetID: eliminated[0] });
    expect((await buyerWS.next((m) => m.type === 'error' && m.request === 'guess')).message).toBe('Your 50/50 ruled that player out.');
    // A player without a charge gets a clear error.
    const otherWS = sockets.find((handle) => handle.playerID !== buyerID)!;
    otherWS.send({ type: 'useFiftyFifty' });
    expect((await otherWS.next((m) => m.type === 'error' && m.request === 'useFiftyFifty')).message).toBe("You don't have a 50/50.");

    for (const handle of sockets) handle.send({ type: 'guess', targetID: round2Owner });
    const results2 = await hostWS.state((s) => s.phase === 'results' && s.lastResult !== null && s.lastResult.index === 2);
    const owner2 = results2.lastResult!.ownerID;
    expect(eliminated).not.toContain(owner2);
    expect(results2.lastResult!.rows.find((row) => row.playerID === buyerID)).toMatchObject({ fiftyFifty: true });
    expect(results2.lastResult!.rows.every((row) => 'earnedFiftyFifty' in row && 'doubleDown' in row && 'roundEffect' in row)).toBe(true);
    for (const handle of sockets) handle.ws.close(1000);
  });
});
