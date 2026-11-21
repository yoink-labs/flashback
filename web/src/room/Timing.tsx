// Timers shared by the countdown, reveal and results. Bars and rings drain with
// a CSS animation (no per-frame React renders); digits re-render only when the
// whole second changes. While the host has paused, everything shows the frozen
// `pausedRemainingMs` instead.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ClientMessage, RoomView } from '../types';
import { PauseIcon } from '../ui/Icons';

export interface Clock {
  endsAt: number | null;
  serverNow: () => number;
  paused: boolean;
  pausedRemainingMs: number | null;
}

const remainingOf = ({ endsAt, serverNow, paused, pausedRemainingMs }: Clock) =>
  paused ? Math.max(0, pausedRemainingMs ?? 0) : endsAt === null ? 0 : Math.max(0, endsAt - serverNow());

/** Whole seconds left, re-rendering only when the number changes. */
export function useSecondsLeft(clock: Clock) {
  const { endsAt, serverNow, paused, pausedRemainingMs } = clock;
  const [left, setLeft] = useState(() => Math.ceil(remainingOf(clock) / 1000));
  useEffect(() => {
    const read = () => Math.ceil(remainingOf({ endsAt, serverNow, paused, pausedRemainingMs }) / 1000);
    setLeft(read());
    if (paused || endsAt === null) return;
    const timer = setInterval(() => setLeft((previous) => (previous === read() ? previous : read())), 200);
    return () => clearInterval(timer);
  }, [endsAt, serverNow, paused, pausedRemainingMs]);
  return left;
}

/**
 * The animation variables, fixed when an element mounts (re-keyed on every new
 * deadline or pause). A CSS animation starts on the first frame the element is
 * rendered, which in a hidden tab (the player switched apps) can be seconds
 * later than now; pinning its start time to the moment `remaining` was read
 * keeps the bar honest to the server clock.
 */
function useDrainStyle<E extends Element>(clock: Clock, totalMs: number, warnMs?: number) {
  const [style] = useState(() => {
    const remaining = remainingOf(clock);
    return {
      readAt: performance.now(),
      css: {
        '--from': Math.min(1, remaining / Math.max(1, totalMs)),
        '--duration': `${remaining}ms`,
        '--warn-delay': `${Math.max(0, remaining - (warnMs ?? 0))}ms`,
      } as CSSProperties,
      warnNow: warnMs !== undefined && remaining <= warnMs,
    };
  });
  const ref = useRef<E>(null);
  useLayoutEffect(() => {
    for (const animation of ref.current?.getAnimations?.() ?? []) animation.startTime = style.readAt;
  }, [style]);
  return { ref, css: style.css, warnNow: style.warnNow };
}

const keyOf = (clock: Clock) => `${clock.endsAt}:${clock.paused}:${clock.pausedRemainingMs}`;

/**
 * A bar that drains from the current fraction to empty by `endsAt`. With
 * `warnMs`, the last stretch turns the bad colour.
 */
export function DrainBar({ clock, totalMs, warnMs, className = '' }: { clock: Clock; totalMs: number; warnMs?: number; className?: string }) {
  return <BarFill key={keyOf(clock)} clock={clock} totalMs={totalMs} warnMs={warnMs} className={className} />;
}

function BarFill({ clock, totalMs, warnMs, className }: { clock: Clock; totalMs: number; warnMs?: number; className: string }) {
  const { ref, css, warnNow } = useDrainStyle<HTMLSpanElement>(clock, totalMs, warnMs);
  return (
    <div className={`drain ${className}${clock.paused ? ' frozen' : ''}${warnMs !== undefined ? ' warns' : ''}${warnNow ? ' ending' : ''}`.trim()} aria-hidden="true">
      <span ref={ref} style={css} />
    </div>
  );
}

/** The countdown's ring: drains smoothly around the digit. */
export function DrainRing({ clock, totalMs, children }: { clock: Clock; totalMs: number; children: React.ReactNode }) {
  return (
    <div className={`ring${clock.paused ? ' frozen' : ''}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="ring-track" cx="50" cy="50" r="45" />
        {clock.endsAt !== null || clock.paused ? <RingFill key={keyOf(clock)} clock={clock} totalMs={totalMs} /> : null}
      </svg>
      <div className="ring-inner">{children}</div>
    </div>
  );
}

function RingFill({ clock, totalMs }: { clock: Clock; totalMs: number }) {
  const { ref, css } = useDrainStyle<SVGCircleElement>(clock, totalMs);
  return <circle ref={ref} className="ring-fill" cx="50" cy="50" r="45" pathLength={1} style={css} />;
}

export function PauseButton({ view, isHost, send, className = '' }: { view: RoomView; isHost: boolean; send: (message: ClientMessage) => void; className?: string }) {
  if (!isHost) return null;
  return (
    <button
      type="button"
      className={`round-btn pause-btn ${className}`.trim()}
      onClick={() => send({ type: view.paused ? 'resume' : 'pause' })}
      aria-label={view.paused ? 'Resume the game' : 'Pause the game'}
      data-testid="pause"
    >
      <PauseIcon />
    </button>
  );
}

/** The thin bar at the top of countdown and results: round on the left, host pause on the right. */
export function GameBar({ view, isHost, send, label }: { view: RoomView; isHost: boolean; send: (message: ClientMessage) => void; label?: string }) {
  const total = view.round?.total ?? view.settings.rounds;
  const index = view.phase === 'results' ? view.lastResult?.index ?? view.round?.index : view.round?.index;
  return (
    <header className="game-bar">
      <span className="caption game-bar-label">{label ?? (index ? `Round ${index} of ${total}` : '')}</span>
      <PauseButton view={view} isHost={isHost} send={send} />
    </header>
  );
}

export const clockOf = (view: RoomView, endsAt: number | null, serverNow: () => number): Clock => ({
  endsAt,
  serverNow,
  paused: view.paused,
  pausedRemainingMs: view.pausedRemainingMs,
});
