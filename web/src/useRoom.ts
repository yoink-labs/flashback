// The room WebSocket for the v2 protocol: connects with the room session token
// as a subprotocol (browsers cannot set headers on WebSockets), reconnects with
// backoff, keeps a server clock offset for timers, and stores refreshed session
// tokens.
//
// Milestone 5 additions (docs/MILESTONE5.md):
//   §1 after each open's first state, say `hello` with the fairReveal cap;
//   §2 ping with an id, keep the lowest-RTT offset of the last 8 samples, and
//      expose `serverNow()` from a monotonic local clock;
//   §3 decode each round's media off-DOM and ack it with `mediaReady`.
//
// Media arrives as binary frames, not HTTP: [4-byte BE length][JSON][bytes].
// Frames are cached in memory by `${game}:${round}` and turned into object URLs,
// which the room shell revokes once the round's results are over.
import { useCallback, useEffect, useRef, useState } from 'react';
import { roomInfo, saveSession, type RoomSession } from './api';
import { ServerClock } from './clockSync';
import { awaitMediaReady } from './mediaReady';
import { normalizeView, type ClientMessage, type MediaHeader, type MediaKind, type RoomView, type ServerMessage, type TurnMessage } from './types';

export type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface MediaEntry {
  key: string;
  kind: MediaKind;
  contentType: string;
  url: string;
  /** The bytes themselves, for Save (fetching a blob: URL can be blocked by CSP). */
  blob: Blob;
}

/** When a round's media became decodable, and its natural pixel size (§3, §6). */
export interface MediaReadyInfo {
  /** Server time at which this client could first show the media. */
  readyAt: number;
  width: number;
  height: number;
}

interface Options {
  /** Called for the private `turn` message. Must never show anything to the player. */
  onTurn?: (turn: TurnMessage) => void;
}

const decoder = new TextDecoder();
/** Background requests whose errors only the round's owner could get. */
const SILENT_REQUESTS = new Set(['pass', 'deck', 'needMedia', 'hello', 'mediaReady']);
/** §2: five pings this far apart on open, then one every 15 s. */
const PING_BURST = 5;
const PING_BURST_MS = 200;
const PING_INTERVAL_MS = 15_000;

/** Parses one binary media frame, or null if it is not one. */
export function parseMediaFrame(data: ArrayBuffer): { header: MediaHeader; blob: Blob } | null {
  if (data.byteLength <= 4) return null;
  const view = new DataView(data);
  const length = view.getUint32(0, false);
  if (length <= 0 || 4 + length > data.byteLength) return null;
  let header: MediaHeader;
  try {
    header = JSON.parse(decoder.decode(new Uint8Array(data, 4, length))) as MediaHeader;
  } catch {
    return null;
  }
  if (!header || header.type !== 'media' || typeof header.game !== 'number' || typeof header.round !== 'number') return null;
  const bytes = new Uint8Array(data, 4 + length);
  return { header, blob: new Blob([bytes], { type: header.contentType || (header.kind === 'video' ? 'video/mp4' : 'image/jpeg') }) };
}

export const mediaKey = (game: number, round: number) => `${game}:${round}`;

/** The round number inside a media key. */
const roundOf = (key: string) => Number(key.slice(key.indexOf(':') + 1));

export function useRoom(session: RoomSession, options: Options = {}) {
  const [view, setView] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<Record<string, MediaEntry>>({});
  const [ready, setReady] = useState<Record<string, MediaReadyInfo>>({});
  const mediaRef = useRef<Record<string, MediaEntry>>({});
  const readyRef = useRef<Record<string, MediaReadyInfo>>({});
  /** Media whose decode has been started (one per key). */
  const primed = useRef(new Set<string>());
  /** Media already acked on this socket. */
  const acked = useRef(new Set<string>());
  /** The `hello` for this socket has gone out (M5 §1). */
  const helloed = useRef(false);
  const clock = useRef(new ServerClock());
  const socket = useRef<WebSocket | null>(null);
  const token = useRef(session.token);
  const onTurn = useRef(options.onTurn);
  onTurn.current = options.onTurn;

  /** Caches a blob for (game, round) and returns its object URL. */
  const storeMedia = useCallback((game: number, round: number, blob: Blob, kind: MediaKind, contentType: string) => {
    const key = mediaKey(game, round);
    if (mediaRef.current[key]) return;
    mediaRef.current[key] = { key, kind, contentType, url: URL.createObjectURL(blob), blob };
    setMedia({ ...mediaRef.current });
  }, []);

  /** Revokes and drops cached media older than (game, round). Omit to drop all. */
  const releaseMedia = useCallback((keep?: { game: number; round: number }) => {
    let changed = false;
    for (const [key, entry] of Object.entries(mediaRef.current)) {
      const [game, round] = key.split(':').map(Number);
      const stale = !keep || game < keep.game || (game === keep.game && round < keep.round);
      if (!stale) continue;
      URL.revokeObjectURL(entry.url);
      delete mediaRef.current[key];
      changed = true;
    }
    if (changed) setMedia({ ...mediaRef.current });
  }, []);

  /**
   * Acks every ready piece of media not yet acked on this socket (§3). Sent
   * after `hello`, so the server already knows this player waits on media.
   */
  const ackReady = useCallback((ws: WebSocket | null) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !helloed.current) return;
    for (const key of Object.keys(readyRef.current)) {
      if (acked.current.has(key)) continue;
      acked.current.add(key);
      ws.send(JSON.stringify({ type: 'mediaReady', round: roundOf(key) } satisfies ClientMessage));
    }
  }, []);

  // §3: decode every piece of media as it arrives — including the next round's,
  // which often lands during the current one — then ack it once.
  useEffect(() => {
    const settle = (key: string, width: number, height: number) => {
      readyRef.current = { ...readyRef.current, [key]: { readyAt: clock.current.serverNow(), width, height } };
      setReady(readyRef.current);
      ackReady(socket.current);
    };
    for (const [key, entry] of Object.entries(media)) {
      if (primed.current.has(key)) continue;
      primed.current.add(key);
      void awaitMediaReady(entry).then(
        (size) => settle(key, size.width, size.height),
        // Media that will not decode still lets the round start; it shows in a
        // fallback frame rather than holding the whole room.
        () => settle(key, 0, 0),
      );
    }
  }, [media, ackReady]);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const timers: ReturnType<typeof setInterval>[] = [];

    const finish = (reason: string) => {
      stopped = true;
      setClosedReason(reason);
      setConnection('closed');
    };
    const stopTimers = () => {
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    };

    const open = () => {
      if (stopped) return;
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/v1/rooms/${session.code}/ws`, ['flashback.v2', `auth.${token.current}`]);
      ws.binaryType = 'arraybuffer';
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnection('open');
        clock.current.beginConnection();
        acked.current.clear();
        helloed.current = false;
        const ping = () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const id = clock.current.pingID();
          ws.send(JSON.stringify({ type: 'ping', id } satisfies ClientMessage));
        };
        // §2: a burst on open, then one every 15 s for the rest of the socket.
        ping();
        let sent = 1;
        const burst = setInterval(() => {
          ping();
          if (++sent >= PING_BURST) clearInterval(burst);
        }, PING_BURST_MS);
        timers.push(burst, setInterval(ping, PING_INTERVAL_MS));
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          const frame = parseMediaFrame(event.data as ArrayBuffer);
          if (frame) storeMedia(frame.header.game, frame.header.round, frame.blob, frame.header.kind, frame.header.contentType);
          return;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case 'state': {
            const state = normalizeView(message.state);
            clock.current.noteState(state.serverNow);
            setView(state);
            // §1: after this socket's first state, announce what we understand.
            if (!helloed.current) {
              helloed.current = true;
              ws.send(JSON.stringify({ type: 'hello', caps: ['fairReveal'] } satisfies ClientMessage));
              ackReady(ws);
            }
            break;
          }
          case 'pong':
            // §2: an M4 server's pong has no id; the state fallback covers it.
            if (typeof message.id === 'number') clock.current.notePong(message.id, message.serverNow);
            break;
          case 'error':
            // Errors from background messages (turn passes, deck counts, media
            // re-requests, M5 acks an older server does not know) must never
            // show: only the round's owner could get them.
            if (!SILENT_REQUESTS.has(message.request ?? '')) setError(message.message || 'Something went wrong.');
            break;
          case 'session':
            token.current = message.token;
            saveSession({ ...session, token: message.token, expiresAt: message.expiresAt });
            break;
          case 'turn':
            onTurn.current?.(message);
            break;
          case 'closed':
            finish(message.reason || 'room-closed');
            break;
        }
      };
      ws.onclose = async (event) => {
        stopTimers();
        if (stopped) return;
        if (event.code === 4000) return finish('room-closed');
        if (event.code === 4001) return finish('removed');
        setConnection('reconnecting');
        attempt += 1;
        // After a few failures, check whether the room still exists.
        if (attempt >= 3) {
          const info = await roomInfo(session.code).catch((e) => (e.status === 404 ? null : undefined));
          if (info === null) return finish('room-closed');
        }
        if (attempt >= 8) return finish('lost');
        retry = setTimeout(open, Math.min(8000, 400 * 2 ** attempt));
      };
    };
    open();
    const wake = () => {
      if (document.visibilityState === 'visible' && socket.current?.readyState === WebSocket.CLOSED && !stopped) {
        clearTimeout(retry);
        open();
      }
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      stopped = true;
      clearTimeout(retry);
      stopTimers();
      document.removeEventListener('visibilitychange', wake);
      socket.current?.close(1000);
    };
  }, [session, storeMedia, ackReady]);

  // The room lives and dies with this hook, so nothing cached outlives it.
  useEffect(
    () => () => {
      for (const entry of Object.values(mediaRef.current)) URL.revokeObjectURL(entry.url);
      mediaRef.current = {};
    },
    [],
  );

  const send = useCallback((message: ClientMessage) => {
    setError(null);
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
    else setError('Reconnecting… try again in a moment.');
  }, []);

  /** §2: monotonic local time plus the lowest-RTT server offset. */
  const serverNow = useCallback(() => clock.current.serverNow(), []);

  return { view, connection, closedReason, error, setError, send, serverNow, token, media, ready, storeMedia, releaseMedia };
}

export type RoomController = ReturnType<typeof useRoom>;
