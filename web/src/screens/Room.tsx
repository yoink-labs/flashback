// The room shell: owns the socket and the deck for the whole room session, then
// hands each phase to its own screen. The deck and the prepared item live here,
// so folding, phase changes, and Play Again never lose them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { leaveRoom, normalizeCode, savedSession, type RoomSession } from '../api';
import { useDeck } from '../deck';
import { deckKey } from '../deckStore';
import { guessElapsedMs, revealDue } from '../fair';
import { releaseThumbs } from '../thumbs';
import { STANDARD_BUNCH, type ClientMessage, type RoomView, type TurnMessage } from '../types';
import { PauseIcon, PlayIcon } from '../ui/Icons';
import { Toaster } from '../ui/Toast';
import { mediaKey, useRoom } from '../useRoom';
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

interface PendingPick {
  /** `${game}:${round}` the tap belongs to. */
  key: string;
  targetID: string;
  /** Measured at the tap, so a held pick keeps its fair time (§4). */
  elapsedMs: number;
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

  // docs/MILESTONE5.md §3: while the countdown's reveal time is fixed, watch
  // the server clock so the reveal can start locally the moment it passes.
  const roundKey = view?.round ? mediaKey(view.game, view.round.index) : null;
  const readyInfo = roundKey ? room.ready[roundKey] : undefined;
  // `revealAt` is present but null until the countdown's time is fixed.
  const scheduledRevealAt =
    view?.phase === 'countdown' && !view.paused && typeof view.round?.revealAt === 'number' ? view.round.revealAt : undefined;
  const [tickNow, setTickNow] = useState<number | null>(null);
  const serverNow = room.serverNow;
  useEffect(() => {
    if (scheduledRevealAt === undefined) {
      setTickNow(null);
      return;
    }
    setTickNow(serverNow());
    const timer = setInterval(() => setTickNow(serverNow()), 100);
    return () => clearInterval(timer);
  }, [scheduledRevealAt, serverNow]);
  const localReveal =
    view !== null &&
    revealDue({
      phase: view.phase,
      revealAt: view.round?.revealAt,
      now: tickNow ?? room.serverNow(),
      mediaReady: Boolean(readyInfo),
      paused: view.paused,
    });

  // §3/§4: a pick made before the reveal state arrives is shown selected and
  // held; it is sent — with the elapsed time measured at the tap — as soon as
  // the reveal state arrives.
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  useEffect(() => {
    setPendingPick(null);
  }, [roundKey]);
  const connection = room.connection;
  const send = room.send;
  useEffect(() => {
    if (!pendingPick || !view || view.phase !== 'reveal' || !view.round) return;
    if (pendingPick.key !== roundKey) {
      setPendingPick(null);
      return;
    }
    if (connection !== 'open') return;
    // The server already has this player's guess, or they are watching.
    if (view.round.yourGuess || view.round.canGuess === false) {
      setPendingPick(null);
      return;
    }
    send({ type: 'guess', targetID: pendingPick.targetID, elapsedMs: pendingPick.elapsedMs });
    setPendingPick(null);
  }, [pendingPick, view, roundKey, connection, send]);
  const pickTarget = useCallback(
    (targetID: string) => {
      if (!view?.round || !roundKey) return;
      const at = room.serverNow();
      const revealAt = view.round.revealAt ?? at;
      const displayedAt = room.ready[roundKey]?.readyAt ?? at;
      const elapsedMs = guessElapsedMs(at, revealAt, displayedAt);
      if (view.phase === 'reveal') room.send({ type: 'guess', targetID, elapsedMs });
      else setPendingPick({ key: roundKey, targetID, elapsedMs });
    },
    [view, roundKey, room],
  );

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
        {view.phase === 'countdown' && !localReveal && <Countdown view={view} serverNow={room.serverNow} isHost={isHost} send={room.send} />}
        {(view.phase === 'reveal' || (view.phase === 'countdown' && localReveal)) && (
          <Reveal
            view={view}
            room={room}
            isHost={isHost}
            pendingPick={pendingPick && pendingPick.key === roundKey ? pendingPick.targetID : null}
            onPick={pickTarget}
          />
        )}
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
