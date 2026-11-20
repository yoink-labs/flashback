// End-to-end through the Worker, the room Durable Object, WebSockets, and R2.
import { env, SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { useClerkKeysForTesting } from '../src/clerk';
import { COUNTDOWN_MS, EMPTY_ROOM_GRACE_MS, type RoomView } from '../src/game';
import type { Room } from '../src/room';
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

type Message = { type: string; state?: RoomView; message?: string; reason?: string };

async function socket(code: string, token: string, viaHeader = false) {
  const res = await SELF.fetch(`${base}/v1/rooms/${code}/ws`, {
    headers: viaHeader ? { Upgrade: 'websocket', Authorization: `Bearer ${token}` } : { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `flashback.v1, auth.${token}` },
  });
  expect(res.status).toBe(101);
  if (!viaHeader) expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('flashback.v1');
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Message[] = [];
  const waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data as string) as Message;
    const waiter = waiters.find((w) => w.match(message));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    } else inbox.push(message);
  });
  return {
    ws,
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    next(match: (m: Message) => boolean = () => true): Promise<Message> {
      const index = inbox.findIndex(match);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error('timed out waiting for message')), 3000);
      });
    },
    async state(match: (s: RoomView) => boolean = () => true) {
      for (;;) {
        const m = await this.next((m) => m.type === 'state' && match(m.state!));
        inbox.length = 0;
        return m.state!;
      }
    },
  };
}

async function upload(code: string, token: string, bytes: Uint8Array, type: string) {
  return SELF.fetch(`${base}/v1/rooms/${code}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': type }, body: bytes });
}

const stub = (code: string) => env.ROOMS.get(env.ROOMS.idFromName(code));
async function setClock(code: string, now: number) {
  await runInDurableObject(stub(code), (room: Room) => {
    room.now = () => now;
  });
}
async function mediaKeys(code: string) {
  return (await env.MEDIA.list({ prefix: `rooms/${code}/` })).objects.map((o) => o.key);
}

describe('rooms over HTTP', () => {
  it('creates a guest room with a share link and a room-scoped session', async () => {
    const host = await create('Host');
    expect(host.code).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
    expect(host.joinURL).toBe(`https://flashback.yoinklabs.dev/join/${host.code}`);
    expect(host.token.split('.')).toHaveLength(3);
    const info = await (await SELF.fetch(`${base}/v1/rooms/${host.code.toLowerCase()}`)).json();
    expect(info).toEqual({ code: host.code, phase: 'lobby', players: 1, capacity: 12, joinable: true });
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
    const cross = await SELF.fetch(`${base}/v1/rooms/${a.code}/ws`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `flashback.v1, auth.${b.token}` } });
    expect(cross.status).toBe(401);
    expect((await upload(a.code, b.token, fakeJpeg(), 'image/jpeg')).status).toBe(401);
    expect((await upload(a.code, 'garbage', fakeJpeg(), 'image/jpeg')).status).toBe(401);
  });
});

describe('a full game over WebSockets with guests and a Clerk player', () => {
  it('plays lobby → countdown → reveal → guess → results → podium → play again, deleting media as it goes', async () => {
    const clerk = await clerkFixture();
    useClerkKeysForTesting(clerk.jwks);
    const clerkToken = await clerk.sign({ azp: 'com.yoinklabs.flashback' }, { sub: 'user_clerk' });

    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const cal = await join(host.code, 'Cal', clerkToken);
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);

    const hostWS = await socket(code, host.token);
    const beaWS = await socket(code, bea.token, true);
    // The signed-in player connects with their Clerk token directly.
    const calWS = await socket(code, clerkToken);
    const lobby = await hostWS.state((s) => s.players.every((p) => p.connected));
    expect(lobby.players.map((p) => [p.nickname, p.isHost, p.signedIn])).toEqual([
      ['Host', true, false],
      ['Bea', false, false],
      ['Cal', false, true],
    ]);
    expect(lobby.startBlocker).toBe('Waiting for Host to add a photo or video.');

    // Host settings, then media that fits the mode.
    hostWS.send({ type: 'settings', rounds: 2, timerSeconds: 20, mediaMode: 'both' });
    await hostWS.state((s) => s.settings.rounds === 2);
    beaWS.send({ type: 'settings', rounds: 5 });
    expect((await beaWS.next((m) => m.type === 'error')).message).toMatch(/Only the host/);

    expect((await upload(code, host.token, fakeJpeg(), 'image/jpeg')).status).toBe(201);
    expect((await upload(code, bea.token, fakeMp4({ durationMs: 6000 }), 'video/mp4')).status).toBe(201);
    expect((await upload(code, clerkToken, fakeJpeg(), 'image/jpeg')).status).toBe(201);
    const tooLong = await upload(code, bea.token, fakeMp4({ durationMs: 20_000 }), 'video/mp4');
    expect(tooLong.status).toBe(422);
    expect((await upload(code, bea.token, fakeJpeg(), 'image/heic')).status).toBe(415);
    const keys = await mediaKeys(code);
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => k.startsWith(`rooms/${code}/`))).toBe(true);
    // Photos are stored without EXIF.
    const stored = new TextDecoder('latin1').decode(await (await env.MEDIA.get(keys[0]))!.arrayBuffer());
    expect(stored).not.toContain('GPSLatitude');

    for (const ws of [hostWS, beaWS, calWS]) ws.send({ type: 'ready', ready: true });
    const ready = await hostWS.state((s) => s.players.every((p) => p.ready));
    expect(ready.startBlocker).toBeNull();
    expect(ready.players.map((p) => [p.photos, p.videos])).toEqual([
      [1, 0],
      [0, 1],
      [1, 0],
    ]);

    hostWS.send({ type: 'start' });
    const countdown = await beaWS.state((s) => s.phase === 'countdown');
    expect(countdown.round).toEqual({ index: 1, total: 2 });

    // The alarm moves the room to the reveal.
    await setClock(code, t0 + COUNTDOWN_MS);
    expect(await runDurableObjectAlarm(stub(code))).toBe(true);
    const views = await Promise.all([hostWS, beaWS, calWS].map((ws) => ws.state((s) => s.phase === 'reveal')));
    const ownerIndex = views.findIndex((v) => v.round!.isYours);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    const sessions = [host, bea, { ...cal, token: clerkToken }];
    const owner = sessions[ownerIndex];
    const guessers = sessions.filter((_, i) => i !== ownerIndex);
    const mediaPath = views[0].round!.mediaPath!;
    expect(views.every((v) => v.round!.mediaPath === mediaPath)).toBe(true);
    expect(mediaPath).toMatch(new RegExp(`^/v1/rooms/${code}/media/[0-9a-f]{64}$`));

    // Media is served only with a valid session, and only during the reveal.
    expect((await SELF.fetch(base + mediaPath)).status).toBe(401);
    const media = await SELF.fetch(base + mediaPath, { headers: { Authorization: `Bearer ${guessers[0].token}` } });
    expect(media.status).toBe(200);
    expect(media.headers.get('Cache-Control')).toBe('private, no-store');
    await media.arrayBuffer();

    // Guess: the first guesser is right, the second picks the other guesser.
    const wsFor = (s: Session) => [hostWS, beaWS, calWS][sessions.indexOf(s)];
    await setClock(code, t0 + COUNTDOWN_MS + 5_000);
    wsFor(guessers[0]).send({ type: 'guess', targetID: owner.playerID });
    await setClock(code, t0 + COUNTDOWN_MS + 6_000);
    wsFor(guessers[1]).send({ type: 'guess', targetID: guessers[0].playerID });
    const results = await hostWS.state((s) => s.phase === 'results');
    expect(results.lastResult!.ownerID).toBe(owner.playerID);
    expect(results.lastResult!.rows.map((r) => [r.playerID, r.correct, r.points])).toEqual([
      [guessers[0].playerID, true, 875],
      [guessers[1].playerID, false, 0],
    ]);
    // The round's media is gone from R2 and its URL is dead.
    expect(await mediaKeys(code)).toHaveLength(2);
    expect((await SELF.fetch(base + mediaPath, { headers: { Authorization: `Bearer ${guessers[0].token}` } })).status).toBe(404);

    // Host ends the game early; unused media is deleted.
    hostWS.send({ type: 'end' });
    const podium = await hostWS.state((s) => s.phase === 'podium');
    expect(podium.podium[0]).toMatchObject({ playerID: guessers[0].playerID, rank: 1, score: 875 });
    expect(await mediaKeys(code)).toHaveLength(0);

    // Play again in the same room: guest and Clerk sessions still work.
    hostWS.send({ type: 'playAgain' });
    const again = await calWS.state((s) => s.phase === 'lobby' && s.game === 2);
    expect(again.players).toHaveLength(3);
    expect((await upload(code, bea.token, fakeJpeg(), 'image/jpeg')).status).toBe(201);
    expect((await upload(code, clerkToken, fakeJpeg(), 'image/jpeg')).status).toBe(201);
    for (const ws of [hostWS, beaWS, calWS]) ws.ws.close();
  });

  it('transfers host on disconnect, deletes media when a player leaves, and tears down empty rooms', async () => {
    const host = await create('Host');
    const bea = await join(host.code, 'Bea');
    const code = host.code;
    const t0 = Date.now();
    await setClock(code, t0);
    const hostWS = await socket(code, host.token);
    const beaWS = await socket(code, bea.token);
    await beaWS.state((s) => s.players.every((p) => p.connected));
    await upload(code, bea.token, fakeJpeg(), 'image/jpeg');
    await upload(code, host.token, fakeJpeg(), 'image/jpeg');
    expect(await mediaKeys(code)).toHaveLength(2);

    hostWS.ws.close(1000);
    const transferred = await beaWS.state((s) => s.hostID === bea.playerID);
    expect(transferred.players.find((p) => p.id === host.playerID)!.connected).toBe(false);

    // Leaving over HTTP deletes the leaver's unused media.
    const left = await SELF.fetch(`${base}/v1/rooms/${code}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${bea.token}` } });
    expect(left.status).toBe(200);
    expect((await beaWS.next((m) => m.type === 'closed')).reason).toBe('removed');
    expect(await mediaKeys(code)).toHaveLength(1);
    // Bea's session no longer works.
    expect((await upload(code, bea.token, fakeJpeg(), 'image/jpeg')).status).toBe(401);

    // Nobody is connected: after the grace period the room and its media are gone.
    await setClock(code, t0 + EMPTY_ROOM_GRACE_MS + 60_000);
    await runDurableObjectAlarm(stub(code));
    expect(await mediaKeys(code)).toHaveLength(0);
    expect((await SELF.fetch(`${base}/v1/rooms/${code}`)).status).toBe(404);
    expect((await post(`/v1/rooms/${code}/join`, { nickname: 'Again' })).status).toBe(404);
  });
});

describe('misc', () => {
  it('serves health and the app-site association', async () => {
    expect(await (await SELF.fetch(`${base}/health`)).json()).toEqual({ service: 'flashback', status: 'ok' });
    const aasa = await (await SELF.fetch(`${base}/.well-known/apple-app-site-association`)).json<{ applinks: { details: { appIDs: string[] }[] } }>();
    expect(aasa.applinks.details[0].appIDs).toEqual(['64PUT29XZ8.com.yoinklabs.flashback']);
  });
});
