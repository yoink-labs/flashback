// The round itself: the media is the hero, the guess grid sits under it, and
// nothing is boxed. Nothing on this screen differs for the owner.
//
// docs/MILESTONE4.md §3–§5: the viewer's private streak effect (greyscale or
// blur) and the round's focus/zoom-out effect are drawn on the media itself,
// driven by the server clock (`revealAt` + the socket's skew) and frozen while
// the host has paused. The power-up bar and the 50/50's greyed-out picks sit
// under the title.
import { useEffect, useRef, useState } from 'react';
import {
  NO_ITEMS,
  type BlurStrength,
  type PlayerItems,
  type RoomView,
  type RoundEffect,
  type RoundView,
  type StreakEffect,
} from '../types';
import { Avatar } from '../ui/Avatar';
import { BlurIcon, DieIcon, FocusIcon, GreyscaleIcon, ScissorsIcon, ShieldIcon, SpeakerOffIcon, SpeakerOnIcon, ZoomIcon } from '../ui/Icons';
import { ItemIcons } from '../ui/ItemIcons';
import { SaveButton } from '../ui/SaveButton';
import { mediaKey, type MediaEntry, type RoomController } from '../useRoom';
import { fiftyFiftyPlayable } from '../settingsModel';
import { HubVideo } from './PlaybackHub';
import { clockOf, DrainBar, PauseButton, useSecondsLeft, type Clock } from './Timing';

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
        <Media
          entry={entry}
          kind={round.kind ?? 'photo'}
          paused={view.paused}
          revealAt={round.revealAt}
          streak={round.yourEffect ?? null}
          effect={round.effect ?? null}
          serverNow={room.serverNow}
        />
        <MediaChips round={round} />
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

function Media({
  entry,
  kind,
  paused,
  revealAt,
  streak,
  effect,
  serverNow,
}: {
  entry: MediaEntry | undefined;
  kind: 'photo' | 'video';
  paused: boolean;
  revealAt: number | undefined;
  streak: StreakEffect | null;
  effect: RoundEffect | null;
  serverNow: () => number;
}) {
  const [slow, setSlow] = useState(false);
  const [element, setElement] = useState<HTMLElement | null>(null);
  useMediaEffect(element, streak, effect, revealAt, paused, serverNow);

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

  if (kind === 'video' || entry.kind === 'video') return <VideoMedia entry={entry} paused={paused} onVideo={setElement} />;
  return <img ref={setElement} className="media" src={entry.url} alt="Whose camera roll is this from?" draggable={false} />;
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

function VideoMedia({ entry, paused, onVideo }: { entry: MediaEntry; paused: boolean; onVideo: (video: HTMLElement | null) => void }) {
  const [muted, setMuted] = useState(true);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);

  // Remember the choice across rounds, but only switch sound on once playback
  // is actually running — browsers block unmuted autoplay.
  useEffect(() => {
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
  }, [element, entry.url]);

  const toggle = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? 'off' : 'on');
    } catch {}
  };

  return (
    <>
      <HubVideo
        src={entry.url}
        playing={!paused}
        muted={muted}
        loop
        className="media"
        onVideo={(video) => {
          setElement(video);
          onVideo(video);
        }}
      />
      <button type="button" className="round-btn on-media mute-btn" onClick={toggle} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Mute the video'}>
        {muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
      </button>
    </>
  );
}

const BLUR_FRACTION: Record<BlurStrength, number> = { light: 0.02, medium: 0.04, heavy: 0.07 };
/** Focus starts at 8% of the media's shorter side and eases out to 0 (§4). */
const FOCUS_FRACTION = 0.08;
const easeOut = (progress: number) => 1 - (1 - progress) ** 3;

/**
 * Draws the streak and round effects on the media element itself, straight
 * from the server clock. A CSS filter's blur is in px, so the fraction is
 * multiplied by the media's shorter side (measured on resize). The animation
 * runs in requestAnimationFrame and writes styles directly — it must not
 * re-render the whole reveal 60 times a second.
 */
function useMediaEffect(
  element: HTMLElement | null,
  streak: StreakEffect | null,
  effect: RoundEffect | null,
  revealAt: number | undefined,
  paused: boolean,
  serverNow: () => number,
) {
  const shorter = useRef(0);
  const frozen = useRef<number | null>(null);
  const live = useRef({ streak, effect, revealAt, paused, serverNow });
  live.current = { streak, effect, revealAt, paused, serverNow };
  const paintRef = useRef<() => boolean>(() => true);

  paintRef.current = () => {
    if (!element) return true;
    const current = live.current;
    const side = shorter.current || Math.min(element.clientWidth, element.clientHeight) || 0;
    const filters: string[] = [];
    if (current.streak?.kind === 'greyscale') filters.push('grayscale(1)');
    let blur = current.streak?.kind === 'blur' ? BLUR_FRACTION[current.streak.strength ?? 'medium'] * side : 0;
    let scale = 1;
    let finished = true;
    if (current.effect && current.revealAt !== undefined) {
      const elapsed = current.paused && frozen.current !== null ? frozen.current : Math.max(0, current.serverNow() - current.revealAt);
      const progress = Math.min(1, Math.max(0, elapsed / current.effect.spanMs));
      const eased = easeOut(progress);
      if (current.effect.kind === 'focus') blur += FOCUS_FRACTION * side * (1 - eased);
      else scale = 1 + ((current.effect.scale ?? 4) - 1) * (1 - eased);
      finished = progress >= 1;
    }
    if (blur > 0.05) filters.push(`blur(${blur.toFixed(2)}px)`);
    element.style.filter = filters.length ? filters.join(' ') : '';
    element.style.transform = scale !== 1 ? `scale(${scale.toFixed(4)})` : '';
    element.style.transformOrigin =
      current.effect?.kind === 'zoom' ? `${((current.effect.originX ?? 0.5) * 100).toFixed(2)}% ${((current.effect.originY ?? 0.5) * 100).toFixed(2)}%` : '';
    return finished;
  };

  // The shorter side changes with the viewport (rotation, fold, resize).
  useEffect(() => {
    if (!element) return;
    const measure = () => {
      shorter.current = Math.min(element.clientWidth, element.clientHeight) || 0;
      paintRef.current();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  // Freeze the elapsed time while the host has paused; the server shifts
  // `revealAt` by the pause length on resume, so time simply picks up again.
  useEffect(() => {
    if (paused) frozen.current = revealAt !== undefined ? Math.max(0, serverNow() - revealAt) : 0;
    else frozen.current = null;
    paintRef.current();
  }, [paused, revealAt, serverNow]);

  const key = `${streak?.kind ?? ''}:${streak?.strength ?? ''}:${effect?.kind ?? ''}:${effect?.spanMs ?? ''}:${effect?.scale ?? ''}:${revealAt ?? ''}`;
  useEffect(() => {
    if (!element) return;
    paintRef.current();
    const reset = () => {
      element.style.filter = '';
      element.style.transform = '';
      element.style.transformOrigin = '';
    };
    if (!effect || paused) return reset;
    let frame = 0;
    const tick = () => {
      if (paintRef.current()) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      reset();
    };
    // `key` already covers the effect's fields; the object itself is rebuilt by
    // every state broadcast, so depending on it would restart the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, key, paused]);
}

/** The small top-leading chips that explain the effect on the media (§3, §4). */
function MediaChips({ round }: { round: RoundView }) {
  const streak = round.yourEffect ?? null;
  const effect = round.effect ?? null;
  if (!streak && !effect) return null;
  return (
    <div className="media-chips" aria-live="polite">
      {streak && (
        <span className="media-chip" data-testid="streak-chip">
          {streak.kind === 'greyscale' ? <GreyscaleIcon size={14} /> : <BlurIcon size={14} />}
          {streak.kind === 'greyscale' ? 'Greyscale' : 'Blur'} · {streak.streak} {streak.trigger === 'right' ? 'right' : 'wrong'} in a row
        </span>
      )}
      {effect && (
        <span className="media-chip" data-testid="round-effect-chip">
          {effect.kind === 'focus' ? <FocusIcon size={14} /> : <ZoomIcon size={14} />}
          {effect.kind === 'focus' ? 'Focus' : 'Zoom-out'} · guess early for a bonus
        </span>
      )}
    </div>
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
  const eliminated = new Set(round.eliminated ?? []);

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
      <PowerupBar view={view} room={room} />
      <div className="guess-grid" role="group" aria-label="Who does this belong to?">
        {view.players.map((player, index) => {
          const picked = guess === player.id;
          const out = eliminated.has(player.id);
          return (
            <button
              key={player.id}
              type="button"
              className={`guess${picked ? ' picked' : ''}${out ? ' eliminated disabled' : ''}`}
              disabled={locked || view.paused || out}
              aria-pressed={picked}
              aria-disabled={out || undefined}
              aria-label={out ? `${player.nickname} is ruled out` : undefined}
              onClick={() => room.send({ type: 'guess', targetID: player.id })}
            >
              <span className="guess-avatar">
                <Avatar name={player.nickname} colorIndex={index} size="lg" dimmed={(locked && !picked) || (view.paused && !locked) || out} />
                <ItemIcons items={player.items} className="guess-items" />
              </span>
              <span className="guess-name">{player.id === view.you.id ? 'You' : player.nickname}</span>
              {out && <span className="guess-out">ruled out</span>}
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

/** docs/MILESTONE4.md §5/§9: the viewer's 50/50 and armed items, under the title. */
function PowerupBar({ view, room }: { view: RoomView; room: RoomController }) {
  const round = view.round!;
  const me = view.players.find((player) => player.id === view.you.id);
  const items: PlayerItems = me?.items ?? NO_ITEMS;
  const held = items.fiftyFifty;
  // `eliminated` is empty when the 50/50 greys nothing (a 2-player room has
  // floor(1 / 2) = 0 picks), so remember the click too.
  const [usedNow, setUsedNow] = useState(false);
  const roundKey = `${view.game}:${round.index}`;
  useEffect(() => setUsedNow(false), [roundKey]);
  const used = usedNow || (round.eliminated?.length ?? 0) > 0;
  // Only what the viewer holds or just spent: no dead "50/50 ×0" pill.
  if (!held && !used && !items.doubleDown && !items.shield) return null;
  const locked = Boolean(round.yourGuess);
  const playable = fiftyFiftyPlayable(view.players.length);
  const canUse = round.canGuess === true && !locked && held > 0 && !used && !view.paused && playable;

  return (
    <div className="powerup-bar">
      {(held > 0 || used) && (
        <button
          type="button"
          className={`powerup-btn${held > 0 ? ' charged' : ''}`}
          disabled={!canUse}
          onClick={() => {
            setUsedNow(true);
            room.send({ type: 'useFiftyFifty' });
          }}
          aria-label={
            used
              ? '50/50 already used this round'
              : !playable
                ? 'Nobody to cut with this many players'
                : `Use a 50/50, ${held} left`
          }
          title={!playable ? 'Nobody to cut with this many players' : undefined}
          data-testid="fifty-fifty"
        >
          <ScissorsIcon size={16} />
          {used ? '50/50 used' : `50/50 ×${held}`}
        </button>
      )}
      {items.doubleDown > 0 && (
        <span className="powerup-pill" data-testid="double-down-pill">
          <DieIcon size={14} />
          Double Down armed
        </span>
      )}
      {items.shield > 0 && (
        <span className="powerup-pill" data-testid="shield-pill">
          <ShieldIcon size={14} />
          Shield on
        </span>
      )}
    </div>
  );
}
