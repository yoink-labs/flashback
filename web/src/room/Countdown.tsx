// Full-screen countdown. While the server is still waiting for an owner to
// supply the item, the digit becomes three cards shuffling.
import { useEffect, useState } from 'react';
import type { RoomView } from '../types';

export function Countdown({ view, serverNow }: { view: RoomView; serverNow: () => number }) {
  const round = view.round;
  const waiting = Boolean(round?.waiting) || view.phaseEndsAt === null;
  const left = useSecondsLeft(waiting ? null : view.phaseEndsAt, serverNow);

  return (
    <section className="screen countdown-screen" aria-live="polite" aria-atomic="true">
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
          <p key={left} className="countdown-digit">
            {Math.max(1, left)}
          </p>
        )}
      </div>
    </section>
  );
}

/** Whole seconds left, re-rendering only when the number changes. */
function useSecondsLeft(endsAt: number | null, serverNow: () => number) {
  const [left, setLeft] = useState(() => (endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - serverNow()) / 1000))));

  useEffect(() => {
    if (endsAt === null) return;
    const update = () => setLeft((previous) => {
      const next = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      return previous === next ? previous : next;
    });
    update();
    const timer = setInterval(update, 150);
    return () => clearInterval(timer);
  }, [endsAt, serverNow]);

  return left;
}
