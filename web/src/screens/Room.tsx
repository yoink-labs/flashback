// The room shell: owns the socket and the deck for the whole room session, then
// hands each phase to its own screen. The deck and the prepared item live here,
// so folding, phase changes, and Play Again never lose them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { leaveRoom, normalizeCode, savedSession, type RoomSession } from '../api';
import { useDeck } from '../deck';
import type { TurnMessage } from '../types';
import { useRoom } from '../useRoom';
import { Countdown } from '../room/Countdown';
import { Lobby } from '../room/Lobby';
import { Podium } from '../room/Podium';
import { Results } from '../room/Results';
import { Reveal } from '../room/Reveal';

export function RoomScreen() {
  const code = normalizeCode(useParams().code ?? '');
  const session = useMemo(() => savedSession(code), [code]);
  if (!session) return <Navigate to={`/join/${code}`} replace />;
  return <Room session={session} />;
}

function Room({ session }: { session: RoomSession }) {
  const navigate = useNavigate();
  const turnBridge = useRef<(turn: TurnMessage) => void>(() => {});
  const room = useRoom(session, { onTurn: (turn) => turnBridge.current(turn) });
  const sessionNow = useCallback(() => ({ ...session, token: room.token.current }), [session, room.token]);
  const view = room.view;

  const me = view?.players.find((player) => player.id === view.you.id);
  const deck = useDeck({
    send: room.send,
    session: sessionNow,
    mode: view?.settings.mediaMode ?? 'both',
    phase: view?.phase ?? 'lobby',
    ready: Boolean(me?.ready),
    connected: room.connection === 'open',
    game: view?.game ?? 1,
    onUploaded: (game, round, blob, kind) => room.storeMedia(game, round, blob, kind, kind === 'photo' ? 'image/jpeg' : 'video/mp4'),
  });

  useEffect(() => {
    turnBridge.current = deck.handleTurn;
  }, [deck.handleTurn]);

  // Media is only useful while its round is on screen. Release everything else.
  const phase = view?.phase;
  const game = view?.game;
  const roundIndex = view?.round?.index;
  const resultIndex = view?.lastResult?.index;
  const releaseMedia = room.releaseMedia;
  useEffect(() => {
    if (!phase) return;
    if (phase === 'lobby' || phase === 'podium' || phase === 'closed') return releaseMedia();
    const keep = phase === 'results' ? resultIndex : roundIndex;
    if (keep !== undefined) releaseMedia({ game: game ?? 1, round: keep });
  }, [phase, game, roundIndex, resultIndex, releaseMedia]);

  const leave = useCallback(async () => {
    if (phase && (phase === 'countdown' || phase === 'reveal' || phase === 'results') && !window.confirm('Leave this game? Your seat goes away.')) return;
    await leaveRoom(sessionNow());
    navigate('/');
  }, [phase, sessionNow, navigate]);

  if (room.connection === 'closed' || view?.phase === 'closed')
    return (
      <main className="screen center-screen">
        <div className="notice">
          <h1 className="title">{closedTitle(room.closedReason)}</h1>
          <p className="caption">Nothing from this room was kept.</p>
          <Link className="btn primary action-btn" to="/">
            Back to start
          </Link>
        </div>
      </main>
    );

  if (!view)
    return (
      <main className="screen center-screen">
        <div className="notice">
          <span className="spinner" aria-hidden="true" />
          <p className="caption">{room.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</p>
        </div>
      </main>
    );

  const isHost = view.hostID === view.you.id;

  return (
    <main className={`room phase-${view.phase}`}>
      {room.connection !== 'open' && (
        <div className="conn-note" role="status">
          Reconnecting…
        </div>
      )}
      {room.error && (
        <button type="button" className="conn-note error" role="alert" onClick={() => room.setError(null)}>
          {room.error}
        </button>
      )}

      <div className="room-body" key={view.phase}>
        {view.phase === 'lobby' && <Lobby view={view} deck={deck} isHost={isHost} send={room.send} onLeave={leave} />}
        {view.phase === 'countdown' && <Countdown view={view} serverNow={room.serverNow} />}
        {view.phase === 'reveal' && <Reveal view={view} room={room} />}
        {view.phase === 'results' && <Results view={view} room={room} isHost={isHost} />}
        {view.phase === 'podium' && <Podium view={view} isHost={isHost} send={room.send} onLeave={leave} />}
      </div>
    </main>
  );
}

const closedTitle = (reason: string | null) =>
  reason === 'removed' ? 'You left the room' : reason === 'lost' ? 'Connection lost' : 'This room has closed';
