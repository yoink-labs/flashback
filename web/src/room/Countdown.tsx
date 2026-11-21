// A calm countdown (docs/MILESTONE3.md §10): the round caption and a ~96 px
// ring draining around the digit, inside the normal room layout with the top
// bar (host pause). While the server is still waiting for the round's item, the
// ring's place holds three small cards shuffling.
import type { ClientMessage, RoomView } from '../types';
import { clockOf, DrainRing, GameBar, useSecondsLeft } from './Timing';

const COUNTDOWN_MS = 3000;

export function Countdown({ view, serverNow, isHost, send }: { view: RoomView; serverNow: () => number; isHost: boolean; send: (message: ClientMessage) => void }) {
  const round = view.round;
  const clock = clockOf(view, view.phaseEndsAt, serverNow);
  const waiting = view.paused ? view.pausedRemainingMs === null : Boolean(round?.waiting) || view.phaseEndsAt === null;
  const left = useSecondsLeft(clock);

  return (
    <section className="screen game-screen countdown-screen" aria-live="polite" aria-atomic="true">
      <GameBar view={view} isHost={isHost} send={send} label="" />
      <div className="countdown-inner">
        {round && <p className="caption countdown-round">Round {round.index} of {round.total}</p>}
        {waiting ? (
          <>
            <div className="shuffle-stack" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className="countdown-word">Shuffling…</p>
          </>
        ) : (
          <>
            <DrainRing clock={clock} totalMs={COUNTDOWN_MS}>
              <span key={left} className="countdown-digit">
                {Math.max(1, left)}
              </span>
            </DrainRing>
          </>
        )}
      </div>
    </section>
  );
}
