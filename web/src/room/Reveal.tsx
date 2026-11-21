// The round itself: the media is the hero, the guess grid sits under it, and
// nothing is boxed. Nothing on this screen differs for the owner.
//
// docs/MILESTONE4.md §3–§5: the viewer's private streak effect (greyscale or
// blur) and the round's focus/zoom-out effect are drawn on the media itself,
// driven by the server clock (`revealAt` + the socket's skew) and frozen while
// the host has paused. The power-up bar and the 50/50's greyed-out picks sit
// under the title.
//
// docs/MILESTONE5.md §3–§6: this screen can also be drawn from a fixed
// countdown (the local reveal), the media sits whole inside a box with its own
// aspect ratio and every effect attaches to that box, the streak blur clears at
// 75% of the timer, and each guess carries its tap's `elapsedMs`.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BLUR_CLEAR_FRACTION, blurRadiusPx } from '../fair';
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
import { mediaKey, type MediaEntry, type MediaReadyInfo, type RoomController } from '../useRoom';
import { fiftyFiftyPlayable } from '../settingsModel';
import { HubVideo } from './PlaybackHub';
import { clockOf, DrainBar, PauseButton, useSecondsLeft, type Clock } from './Timing';

const MUTE_KEY = 'flashback.muted';

export function Reveal({
  view,
  room,
  isHost,
  pendingPick = null,
  onPick,
}: {
  view: RoomView;
  room: RoomController;
  isHost: boolean;
  /** A pick made before the reveal state arrived, held until it does (§3). */
  pendingPick?: string | null;
  onPick: (targetID: string) => void;
}) {
  const round = view.round;
  if (!round) return null;
  const key = mediaKey(view.game, round.index);
  const entry = room.media[key];
  const ready = room.ready[key];
  const timerMs = view.settings.timerSeconds * 1000;
  // §4: the timer is always against `round.endsAt`, never the grace-inclusive
  // `phaseEndsAt`. A local reveal does not have `endsAt` yet, so it estimates
  // from `revealAt` and the round timer.
  const revealAt = typeof round.revealAt === 'number' ? round.revealAt : undefined;
  const local = view.phase !== 'reveal';
  const endsAt = local ? (revealAt !== undefined ? revealAt + timerMs : null) : round.endsAt ?? null;
  const clock = clockOf(view, endsAt, room.serverNow);
  const total = endsAt !== null && revealAt !== undefined ? Math.max(1, endsAt - revealAt) : timerMs;

  return (
    <div className="reveal-screen">
      <DrainBar clock={clock} totalMs={total} warnMs={5000} className="timerbar" />

      <div className="reveal-media">
        <Media
          entry={entry}
          size={ready}
          kind={round.kind ?? 'photo'}
          paused={view.paused}
          revealAt={revealAt}
          timerMs={timerMs}
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
        <GuessPanel view={view} room={room} pendingPick={pendingPick} onPick={onPick} />
      </div>
    </div>
  );
}

function Seconds({ clock }: { clock: Clock }) {
  const left = useSecondsLeft(clock);
  return <span className="caption seconds">{left}s</span>;
}

/**
 * The media fills a box with its own aspect ratio, centred in the dark stage
 * (§6). The box is what effects attach to: its shorter side sets the blur
 * radius, its origin fractions anchor the zoom, and the clip wrapper keeps the
 * zoomed media inside the media's own rectangle (§5).
 */
function Media({
  entry,
  size,
  kind,
  paused,
  revealAt,
  timerMs,
  streak,
  effect,
  serverNow,
}: {
  entry: MediaEntry | undefined;
  size: MediaReadyInfo | undefined;
  kind: 'photo' | 'video';
  paused: boolean;
  revealAt: number | undefined;
  timerMs: number;
  streak: StreakEffect | null;
  effect: RoundEffect | null;
  serverNow: () => number;
}) {
  const [slow, setSlow] = useState(false);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [muted, setMuted] = useState(true);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useMediaEffect(box, streak, effect, revealAt, timerMs, paused, serverNow);

  // Remember the sound choice across rounds, but only switch sound on once
  // playback is actually running — browsers block unmuted autoplay.
  useEffect(() => {
    if (!video) return;
    let remembered = false;
    try {
      remembered = localStorage.getItem(MUTE_KEY) === 'on';
    } catch {}
    if (!remembered) return;
    const enable = () => {
      video.muted = false;
      setMuted(false);
    };
    if (!video.paused) enable();
    else video.addEventListener('playing', enable, { once: true });
    return () => video.removeEventListener('playing', enable);
  }, [video]);

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

  // 16:9 until the natural size is known; the round only reveals locally once
  // the media is decoded, so this is only the M4-server fallback.
  const ratio = size && size.width > 0 && size.height > 0 ? size.width / size.height : 16 / 9;
  const videoRound = kind === 'video' || entry.kind === 'video';
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try {
      localStorage.setItem(MUTE_KEY, next ? 'off' : 'on');
    } catch {}
  };
  return (
    <>
      <div className="media-clip" style={{ '--ar': ratio } as CSSProperties} data-testid="media-clip">
        <div className="media-box" ref={setBox}>
          {videoRound ? (
            <HubVideo src={entry.url} playing={!paused} muted={muted} loop className="media" onVideo={setVideo} />
          ) : (
            <img className="media" src={entry.url} alt="Whose camera roll is this from?" draggable={false} />
          )}
        </div>
      </div>
      {/* Outside the box: the effects blur and scale the box, never the buttons. */}
      {videoRound && (
        <button type="button" className="round-btn on-media mute-btn" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Mute the video'}>
          {muted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
        </button>
      )}
    </>
  );
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

const BLUR_FRACTION: Record<BlurStrength, number> = { light: 0.02, medium: 0.04, heavy: 0.07 };
/** Focus starts at 8% of the media's shorter side and eases out to 0 (§4). */
const FOCUS_FRACTION = 0.08;
const easeOut = (progress: number) => 1 - (1 - progress) ** 3;

/**
 * Draws the streak and round effects on the media's box, straight from the
 * server clock. A CSS filter's blur is in px, so the fraction is multiplied by
 * the box's shorter side (measured on resize). The animation runs in
 * requestAnimationFrame and writes styles directly — it must not re-render the
 * whole reveal 60 times a second. The streak blur fades over the round even
 * when there is no focus/zoom effect, so the loop runs whenever anything is
 * still changing.
 */
function useMediaEffect(
  element: HTMLElement | null,
  streak: StreakEffect | null,
  effect: RoundEffect | null,
  revealAt: number | undefined,
  timerMs: number,
  paused: boolean,
  serverNow: () => number,
) {
  const shorter = useRef(0);
  const frozen = useRef<number | null>(null);
  const live = useRef({ streak, effect, revealAt, timerMs, paused, serverNow });
  live.current = { streak, effect, revealAt, timerMs, paused, serverNow };
  const paintRef = useRef<() => boolean>(() => true);

  paintRef.current = () => {
    if (!element) return true;
    const current = live.current;
    const side = shorter.current || Math.min(element.clientWidth, element.clientHeight) || 0;
    const filters: string[] = [];
    const timed = current.revealAt !== undefined;
    const elapsed = !timed
      ? 0
      : current.paused && frozen.current !== null
        ? frozen.current
        : Math.max(0, current.serverNow() - current.revealAt!);
    if (current.streak?.kind === 'greyscale') filters.push('grayscale(1)');
    let blur = 0;
    let scale = 1;
    let finished = true;
    if (current.streak?.kind === 'blur') {
      blur = blurRadiusPx(BLUR_FRACTION[current.streak.strength ?? 'medium'], side, elapsed, current.timerMs);
      // §5: sharp by BLUR_CLEAR_FRACTION of the round; until then it changes.
      finished = !timed || current.timerMs <= 0 || elapsed >= BLUR_CLEAR_FRACTION * current.timerMs;
    }
    if (current.effect && timed) {
      const progress = Math.min(1, Math.max(0, elapsed / current.effect.spanMs));
      const eased = easeOut(progress);
      if (current.effect.kind === 'focus') blur += FOCUS_FRACTION * side * (1 - eased);
      else scale = 1 + ((current.effect.scale ?? 4) - 1) * (1 - eased);
      finished = finished && progress >= 1;
    }
    if (blur > 0.05) filters.push(`blur(${blur.toFixed(2)}px)`);
    element.style.filter = filters.length ? filters.join(' ') : '';
    element.style.transform = scale !== 1 ? `scale(${scale.toFixed(4)})` : '';
    element.style.transformOrigin =
      current.effect?.kind === 'zoom' ? `${((current.effect.originX ?? 0.5) * 100).toFixed(2)}% ${((current.effect.originY ?? 0.5) * 100).toFixed(2)}%` : '';
    return finished;
  };

  // The box's shorter side changes with the viewport (rotation, fold, resize).
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

  const animated = Boolean(effect) || (streak?.kind === 'blur' && revealAt !== undefined && timerMs > 0);
  const key = `${streak?.kind ?? ''}:${streak?.strength ?? ''}:${effect?.kind ?? ''}:${effect?.spanMs ?? ''}:${effect?.scale ?? ''}:${effect?.originX ?? ''}:${effect?.originY ?? ''}:${revealAt ?? ''}:${timerMs}`;
  useEffect(() => {
    if (!element) return;
    paintRef.current();
    const reset = () => {
      element.style.filter = '';
      element.style.transform = '';
      element.style.transformOrigin = '';
    };
    // The paint above already drew the frozen state; no frames while paused.
    if (!animated || paused) return reset;
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
  }, [element, key, paused, animated]);
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

function GuessPanel({
  view,
  room,
  pendingPick,
  onPick,
}: {
  view: RoomView;
  room: RoomController;
  pendingPick: string | null;
  onPick: (targetID: string) => void;
}) {
  const round = view.round!;
  useMediaRequest(room, view, room.media[mediaKey(view.game, round.index)]);
  // A held pick (made before the reveal state arrived) looks like a normal one.
  const guess = round.yourGuess ?? pendingPick ?? null;
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
              onClick={() => onPick(player.id)}
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
      {locked && round.guessedCount !== undefined && (
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
