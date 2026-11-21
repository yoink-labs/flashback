// Host pause (docs/MILESTONE3.md §3). A pause freezes the phase clock: the
// phase deadline is cleared and the time it had left is remembered. On resume
// every round timer that was running moves forward by the paused gap, so the
// phase keeps exactly the time it had left and speed scoring never counts the
// pause.
//
// This module owns only the timing rules. The caller owns the policy around
// them: the host check, which phases may pause, and what runs after a resume.
// It is pure state — no sockets, no media, no storage.

/**
 * The slice of room state a pause touches. `phase` is a plain string so the
 * room's `Phase` union fits without this module importing the game back.
 */
export interface PausableState {
  phase: string;
  phaseEndsAt: number | null;
  pausedAt: number | null;
  pausedRemainingMs: number | null;
  round: { slotID: string; countdownStart: number; revealAt: number | null; endsAt: number | null } | null;
  slots: readonly { id: string; status: 'requested' | 'ready' }[];
}

/** A resumed phase always shows for at least this long before it can end. */
const MIN_RESUME_MS = 1_000;

/** Freeze the phase. The caller checks the host, the phase, and that it is running. */
export function beginPause(state: PausableState, now: number): void {
  state.pausedAt = now;
  state.pausedRemainingMs = state.phaseEndsAt === null ? null : Math.max(0, state.phaseEndsAt - now);
  state.phaseEndsAt = null;
}

/**
 * Unfreeze the phase and move its timers past the paused gap. `countdownMs` is
 * the room's countdown length, used when the pause began while still waiting
 * for the upload (there was no deadline to remember).
 */
export function endPause(state: PausableState, now: number, countdownMs: number): void {
  const pausedAt = state.pausedAt;
  if (pausedAt === null) return;
  const shift = Math.max(0, now - pausedAt);
  const remaining = state.pausedRemainingMs;
  const round = state.round;
  clearPause(state);
  if (state.phase === 'reveal' && round) {
    if (round.revealAt !== null) round.revealAt += shift;
    if (round.endsAt !== null) round.endsAt += shift;
    state.phaseEndsAt = round.endsAt;
  } else if (state.phase === 'countdown' && round) {
    round.countdownStart += shift;
    const ready = state.slots.some((slot) => slot.id === round.slotID && slot.status === 'ready');
    state.phaseEndsAt = ready ? now + Math.max(remaining ?? countdownMs, MIN_RESUME_MS) : null;
  } else if (state.phase === 'results') {
    state.phaseEndsAt = now + Math.max(remaining ?? 0, MIN_RESUME_MS);
  } else {
    state.phaseEndsAt = null;
  }
}

/** Drop a pause without touching timers (used when the game ends or restarts). */
export function clearPause(state: Pick<PausableState, 'pausedAt' | 'pausedRemainingMs'>): void {
  state.pausedAt = null;
  state.pausedRemainingMs = null;
}
