// The room WebSocket: connects with the room session token as a subprotocol
// (browsers cannot set headers on WebSockets), reconnects with backoff, keeps a
// server clock offset for timers, and stores refreshed session tokens.
import { useCallback, useEffect, useRef, useState } from 'react';
import { roomInfo, saveSession, type RoomSession } from './api';
import type { ClientMessage, RoomView } from './types';

export type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export function useRoom(session: RoomSession) {
  const [view, setView] = useState<RoomView | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offset = useRef(0);
  const socket = useRef<WebSocket | null>(null);
  const token = useRef(session.token);

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
      const ws = new WebSocket(`${scheme}://${location.host}/v1/rooms/${session.code}/ws`, ['flashback.v1', `auth.${token.current}`]);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnection('open');
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'ping' })), 25_000);
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === 'state') {
          offset.current = message.state.serverNow - Date.now();
          setView(message.state);
        } else if (message.type === 'error') setError(message.message);
        else if (message.type === 'session') {
          token.current = message.token;
          saveSession({ ...session, token: message.token, expiresAt: message.expiresAt });
        } else if (message.type === 'closed') finish(message.reason);
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
  }, [session]);

  const send = useCallback((message: ClientMessage) => {
    setError(null);
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
    else setError('Reconnecting… try again in a moment.');
  }, []);

  const serverNow = useCallback(() => Date.now() + offset.current, []);
  return { view, connection, closedReason, error, setError, send, serverNow, token };
}
