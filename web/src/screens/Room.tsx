// The room shell: owns the socket and the deck for the whole room session, then
// hands each phase to its own screen. The deck and the prepared item live here,
// so folding, phase changes, and Play Again never lose them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { leaveRoom, normalizeCode, savedSession, type RoomSession } from '../api';
import { useDeck } from '../deck';
import { deckKey } from '../deckStore';
import { releaseThumbs } from '../thumbs';
import { STANDARD_BUNCH, type ClientMessage, type RoomView, type TurnMessage } from '../types';
import { PauseIcon, PlayIcon } from '../ui/Icons';
import { Toaster } from '../ui/Toast';
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
    swaps: view?.settings.swaps ?? 3,
    sizes: view?.bunch ?? STANDARD_BUNCH,
    phase: view?.phase ?? 'lobby',
    ready: Boolean(me?.ready),
    connected: room.connection === 'open',
    storeKey: deckKey(session.code, session.playerID),
    onUploaded: (game, round, blob, kind) => room.storeMedia(game, round, blob, kind, kind === 'photo' ? 'image/jpeg' : 'video/mp4'),
  });

  useEffect(() => {
    turnBridge.current = deck.handleTurn;
  }, [deck.handleTurn]);

  // Thumbnails live as long as the room does.
  useEffect(() => releaseThumbs, []);

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

  const forgetDeck = deck.forget;
  const leave = useCallback(async () => {
    if (phase && (phase === 'countdown' || phase === 'reveal' || phase === 'results') && !window.confirm('Leave this game? Your seat goes away.')) return;
    await Promise.all([leaveRoom(sessionNow()), forgetDeck()]);
    navigate('/');
  }, [phase, sessionNow, navigate, forgetDeck]);

  // The room is gone (or we were removed): its stored bunch is no use any more.
  // A lost connection keeps it, so coming back later still restores it.
  const gone = view?.phase === 'closed' || (room.connection === 'closed' && room.closedReason !== 'lost');
  useEffect(() => {
    if (gone) void forgetDeck();
  }, [gone, forgetDeck]);

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
        {view.phase === 'countdown' && <Countdown view={view} serverNow={room.serverNow} isHost={isHost} send={room.send} />}
        {view.phase === 'reveal' && <Reveal view={view} room={room} isHost={isHost} />}
        {view.phase === 'results' && <Results view={view} room={room} isHost={isHost} />}
        {view.phase === 'podium' && <Podium view={view} isHost={isHost} send={room.send} onLeave={leave} />}
      </div>

      {view.paused && (view.phase === 'countdown' || view.phase === 'reveal' || view.phase === 'results') && (
        <PauseOverlay view={view} isHost={isHost} send={room.send} />
      )}
      <Toaster />
    </main>
  );
}

/** A calm full-screen hold while the host has paused. */
function PauseOverlay({ view, isHost, send }: { view: RoomView; isHost: boolean; send: (message: ClientMessage) => void }) {
  const host = view.players.find((player) => player.id === view.hostID);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="pause-overlay" role="dialog" aria-modal="true" aria-labelledby="paused-title" data-testid="pause-overlay">
      <div className="pause-center">
        <span className="pause-glyph" aria-hidden="true">
          <PauseIcon size={30} />
        </span>
        <h1 id="paused-title" className="title">
          Paused
        </h1>
        <p className="caption">{isHost ? 'Nobody can guess until you resume' : `Waiting for ${host?.nickname ?? 'the host'}`}</p>
      </div>
      {isHost && (
        <div className="pause-actions">
          {confirming ? (
            <>
              <p className="caption">End the game for everyone?</p>
              <button type="button" className="btn primary action-btn danger" onClick={() => send({ type: 'end' })} data-testid="confirm-end">
                End game
              </button>
              <button type="button" className="btn text" onClick={() => setConfirming(false)}>
                Keep playing
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn primary action-btn" onClick={() => send({ type: 'resume' })} autoFocus data-testid="resume">
                <PlayIcon size={18} />
                Resume
              </button>
              <button type="button" className="btn text" onClick={() => setConfirming(true)} data-testid="end-game">
                End game
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const closedTitle = (reason: string | null) =>
  reason === 'removed' ? 'You left the room' : reason === 'lost' ? 'Connection lost' : 'This room has closed';
