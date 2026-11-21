// The round itself: the media is the hero, the guess grid sits under it, and
// nothing is boxed. Nothing on this screen differs for the owner.
import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '../types';
import { Avatar } from '../ui/Avatar';
import { SpeakerOffIcon, SpeakerOnIcon } from '../ui/Icons';
import { SaveButton } from '../ui/SaveButton';
import { mediaKey, type MediaEntry, type RoomController } from '../useRoom';
import { clockOf, DrainBar, PauseButton, useSecondsLeft, type Clock } from './Timing';
import { usePlayback } from './usePlayback';

const MUTE_KEY = 'flashback.muted';

export function Reveal({ view, room, isHost }: { view: RoomView; room: RoomController; isHost: boolean }) {
  const round = view.round;
  if (!round) return null;
  const entry = room.media[mediaKey(view.game, round.index)];
  const endsAt = round.endsAt ?? view.phaseEndsAt;
  const clock = clockOf(view, endsAt, room.serverNow);
  const total = endsAt !== null && round.revealAt !== undefined ? Math.max(1, endsAt - round.revealAt) : view.settings.timerSeconds * 1000;

  return (
    <div className="reveal-screen">
      <DrainBar clock={clock} totalMs={total} warnMs={5000} className="timerbar" />

      <div className="reveal-media">
        <Media entry={entry} kind={round.kind ?? 'photo'} paused={view.paused} />
        <div className="media-tools top">
          <PauseButton view={view} isHost={isHost} send={room.send} className="on-media" />
        </div>
        <div className="media-tools bottom-left">
          <SaveButton entry={entry} round={round.index} className="on-media" />
        </div>
      </div>

      <div className="reveal-side">
        <div className="reveal-meta">
          <span className="caption">
            Round {round.index} of {round.total}
          </span>
          <Seconds clock={clock} />
        </div>
        <GuessPanel view={view} room={room} />
      </div>
    </div>
  );
}

function Seconds({ clock }: { clock: Clock }) {
  const left = useSecondsLeft(clock);
  return <span className="caption seconds">{left}s</span>;
}

function Media({ entry, kind, paused }: { entry: MediaEntry | undefined; kind: 'photo' | 'video'; paused: boolean }) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (entry) return;
    setSlow(false);
    const timeout = setTimeout(() => setSlow(true), 2600);
    return () => clearTimeout(timeout);
  }, [entry]);

  if (!entry) {
    return (
      <div className="media-missing" role="status">
        {slow ? (
          <>
            <p className="headline">This one didn’t load</p>
            <p className="caption">Guess anyway</p>
          </>
        ) : (
          <span className="spinner" aria-hidden="true" />
        )}
      </div>
    );
  }

  if (kind === 'video' || entry.kind === 'video') return <VideoMedia entry={entry} paused={paused} />;
  return <img className="media" src={entry.url} alt="Whose camera roll is this from?" draggable={false} />;
}

/** Asks the server to resend the round's media once if it hasn't arrived. */
function useMediaRequest(room: RoomController, view: RoomView, entry: MediaEntry | undefined) {
  const asked = useRef<string | null>(null);
  const key = mediaKey(view.game, view.round?.index ?? 0);
  useEffect(() => {
    if (entry || !view.round || asked.current === key) return;
    asked.current = key;
    room.send({ type: 'needMedia', round: view.round.index });
  }, [entry, key, room.send, view.round]);
}

function VideoMedia({ entry, paused }: { entry: MediaEntry; paused: boolean }) {
  const video = usePlayback(paused);
  const [muted, setMuted] = useState(true);

  // Remember the choice across rounds, but only switch sound on once playback
  // is actually running — browsers block unmuted autoplay.
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let remembered = false;
    try {
      remembered = localStorage.getItem(MUTE_KEY) === 'on';
    } catch {}
    if (!remembered) return;
    const enable = () => {
      element.muted = false;
      setMuted(false);
    };
    if (!element.paused) enable();
    else element.addEventListener('playing', enable, { once: true });
    return () => element.removeEventListener('playing', enable);
  }, [entry.url]);

  const toggle = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? 'off' : 'on');
    } catch {}
  };

  return (
    <>
      <video ref={video} className="media" src={entry.url} autoPlay={!paused} loop playsInline muted={muted} onCanPlay={(event) => !paused && void event.currentTarget.play().catch(() => {})} />
      <button type="button" className="round-btn on-media mute-btn" onClick={toggle} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Mute the video'}>
        {muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
      </button>
    </>
  );
}

function GuessPanel({ view, room }: { view: RoomView; room: RoomController }) {
  const round = view.round!;
  useMediaRequest(room, view, room.media[mediaKey(view.game, round.index)]);
  const guess = round.yourGuess ?? null;
  const locked = Boolean(guess);
  // `canGuess` means "may guess this round" (late joiners cannot). After you
  // have guessed it may be false too, but that is the locked state.
  const watching = round.canGuess === false && !guess;
  const guessed = round.guessedCount ?? 0;
  const guessers = round.guesserCount ?? view.players.length;

  if (watching) {
    return (
      <>
        <h1 className="reveal-title">Watching</h1>
        <p className="caption reveal-status" aria-live="polite">
          {guessed} of {guessers} guessed
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="reveal-title">{locked ? 'Locked in' : view.paused ? 'Paused' : 'Whose is it?'}</h1>
      <div className="guess-grid" role="group" aria-label="Who does this belong to?">
        {view.players.map((player, index) => {
          const picked = guess === player.id;
          return (
            <button
              key={player.id}
              type="button"
              className={`guess${picked ? ' picked' : ''}`}
              disabled={locked || view.paused}
              aria-pressed={picked}
              onClick={() => room.send({ type: 'guess', targetID: player.id })}
            >
              <Avatar name={player.nickname} colorIndex={index} size="lg" dimmed={(locked && !picked) || (view.paused && !locked)} />
              <span className="guess-name">{player.id === view.you.id ? 'You' : player.nickname}</span>
            </button>
          );
        })}
      </div>
      {locked && (
        <p className="caption reveal-status" aria-live="polite">
          {guessed} of {guessers} guessed
        </p>
      )}
    </>
  );
}
