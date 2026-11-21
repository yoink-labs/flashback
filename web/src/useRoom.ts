// The room WebSocket for the v2 protocol: connects with the room session token
// as a subprotocol (browsers cannot set headers on WebSockets), reconnects with
// backoff, keeps a server clock offset for timers, and stores refreshed session
// tokens.
//
// Media arrives as binary frames, not HTTP: [4-byte BE length][JSON][bytes].
// Frames are cached in memory by `${game}:${round}` and turned into object URLs,
// which the room shell revokes once the round's results are over.
import { useCallback, useEffect, useRef, useState } from 'react';
import { roomInfo, saveSession, type RoomSession } from './api';
import type { ClientMessage, MediaHeader, MediaKind, RoomView, TurnMessage } from './types';

export type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface MediaEntry {
  key: string;
  kind: MediaKind;
  contentType: string;
  url: string;
}

interface Options {
  /** Called for the private `turn` message. Must never show anything to the player. */
  onTurn?: (turn: TurnMessage) => void;
}

const decoder = new TextDecoder();

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

export function useRoom(session: RoomSession, options: Options = {}) {
  const [view, setView] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<Record<string, MediaEntry>>({});
  const mediaRef = useRef<Record<string, MediaEntry>>({});
  const offset = useRef(0);
  const socket = useRef<WebSocket | null>(null);
  const token = useRef(session.token);
  const onTurn = useRef(options.onTurn);
  onTurn.current = options.onTurn;

  /** Caches a blob for (game, round) and returns its object URL. */
  const storeMedia = useCallback((game: number, round: number, blob: Blob, kind: MediaKind, contentType: string) => {
    const key = mediaKey(game, round);
    if (mediaRef.current[key]) return;
    mediaRef.current[key] = { key, kind, contentType, url: URL.createObjectURL(blob) };
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

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const finish = (reason: string) => {
      stopped = true;
      setClosedReason(reason);
      setConnection('closed');
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
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })), 30_000);
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          const frame = parseMediaFrame(event.data as ArrayBuffer);
          if (frame) storeMedia(frame.header.game, frame.header.round, frame.blob, frame.header.kind, frame.header.contentType);
          return;
        }
        let message: { type?: string } & Record<string, unknown>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'state') {
          const state = message.state as RoomView;
          offset.current = state.serverNow - Date.now();
          setView(state);
        } else if (message.type === 'error') {
          // Errors from background messages (turn passes, deck counts, media
          // re-requests) must never show: only the round's owner could get them.
          if (!['pass', 'deck', 'needMedia'].includes(String(message.request ?? ''))) setError(String(message.message ?? 'Something went wrong.'));
        }
        else if (message.type === 'session') {
          token.current = String(message.token);
          saveSession({ ...session, token: token.current, expiresAt: Number(message.expiresAt) });
        } else if (message.type === 'turn') onTurn.current?.(message as unknown as TurnMessage);
        else if (message.type === 'closed') finish(String(message.reason ?? 'room-closed'));
      };
      ws.onclose = async (event) => {
        clearInterval(ping);
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
      clearInterval(ping);
      document.removeEventListener('visibilitychange', wake);
      socket.current?.close(1000);
    };
  }, [session, storeMedia]);

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

  const serverNow = useCallback(() => Date.now() + offset.current, []);

  return { view, connection, closedReason, error, setError, send, serverNow, token, media, storeMedia, releaseMedia };
}

export type RoomController = ReturnType<typeof useRoom>;
