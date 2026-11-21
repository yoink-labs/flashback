// The round itself: the media is the hero, the guess grid sits under it, and
// nothing is boxed. Nothing on this screen differs for the owner.
import { memo, useEffect, useRef, useState } from 'react';
import type { RoomView } from '../types';
import { Avatar } from '../ui/Avatar';
import { mediaKey, type MediaEntry, type RoomController } from '../useRoom';

const MUTE_KEY = 'flashback.muted';

export function Reveal({ view, room }: { view: RoomView; room: RoomController }) {
  const round = view.round;
  if (!round) return null;
  const entry = room.media[mediaKey(view.game, round.index)];
  const endsAt = round.endsAt ?? room.serverNow();

  return (
    <div className="reveal-screen">
      <TimerBar key={round.index} endsAt={endsAt} revealAt={round.revealAt ?? endsAt} serverNow={room.serverNow} />

      <div className="reveal-media">
        <Media entry={entry} kind={round.kind ?? 'photo'} />
      </div>

      <div className="reveal-side">
        <div className="reveal-meta">
          <span className="caption">
            {round.index}/{round.total}
          </span>
          <Seconds endsAt={endsAt} serverNow={room.serverNow} />
        </div>
        <GuessPanel view={view} room={room} />
      </div>
    </div>
  );
}

/** The 4-pt line that drains over the round; the last 5 seconds turn red. */
const TimerBar = memo(function TimerBar({ endsAt, revealAt, serverNow }: { endsAt: number; revealAt: number; serverNow: () => number }) {
  const total = Math.max(1, endsAt - revealAt);
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.min(total, endsAt - serverNow())));

  useEffect(() => {
    const update = () => setRemaining(Math.max(0, Math.min(total, endsAt - serverNow())));
    update();
    const timer = setInterval(update, 120);
    return () => clearInterval(timer);
  }, [endsAt, total, serverNow]);

  return (
    <div className={`timerbar${remaining <= 5000 ? ' ending' : ''}`} aria-hidden="true">
      <span style={{ width: `${(remaining / total) * 100}%` }} />
    </div>
  );
});

function Seconds({ endsAt, serverNow }: { endsAt: number; serverNow: () => number }) {
  const left = useSecondsLeft(endsAt, serverNow);
  return <span className="caption seconds">{left}</span>;
}

function useSecondsLeft(endsAt: number, serverNow: () => number) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((endsAt - serverNow()) / 1000)));
  useEffect(() => {
    const update = () => setLeft((previous) => {
      const next = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      return previous === next ? previous : next;
    });
    update();
    const timer = setInterval(update, 200);
    return () => clearInterval(timer);
  }, [endsAt, serverNow]);
  return left;
}

function Media({ entry, kind }: { entry: MediaEntry | undefined; kind: 'photo' | 'video' }) {
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

  if (kind === 'video' || entry.kind === 'video') return <VideoMedia entry={entry} />;
  return <img className="media" src={entry.url} alt="Whose camera roll is this from?" draggable={false} />;
}

/** Exposed for the reveal's `needMedia` nudge. */
export function useMediaRequest(room: RoomController, view: RoomView, entry: MediaEntry | undefined) {
  const asked = useRef<string | null>(null);
  const key = mediaKey(view.game, view.round?.index ?? 0);
  useEffect(() => {
    if (entry || !view.round || asked.current === key) return;
    asked.current = key;
    room.send({ type: 'needMedia', round: view.round.index });
  }, [entry, key, room.send, view.round]);
}

function VideoMedia({ entry }: { entry: MediaEntry }) {
  const video = useRef<HTMLVideoElement>(null);
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
      <video ref={video} className="media" src={entry.url} autoPlay loop playsInline muted={muted} onCanPlay={(event) => void event.currentTarget.play().catch(() => {})} />
      <button type="button" className="mute-btn" onClick={toggle} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Mute the video'}>
        {muted ? <SpeakerOff /> : <SpeakerOn />}
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
      <h1 className="reveal-title">{locked ? 'Locked in' : 'Whose is it?'}</h1>
      <div className="guess-grid" role="group" aria-label="Who does this belong to?">
        {view.players.map((player, index) => {
          const picked = guess === player.id;
          return (
            <button
              key={player.id}
              type="button"
              className={`guess${picked ? ' picked' : ''}`}
              disabled={locked}
              aria-pressed={picked}
              onClick={() => room.send({ type: 'guess', targetID: player.id })}
            >
              <Avatar name={player.nickname} colorIndex={index} size="lg" dimmed={locked && !picked} />
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

function SpeakerOn() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h3l4-4v14l-4-4H4z" />
      <path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" />
    </svg>
  );
}

function SpeakerOff() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h3l4-4v14l-4-4H4z" />
      <path d="M16 9l5 6M21 9l-5 6" />
    </svg>
  );
}
