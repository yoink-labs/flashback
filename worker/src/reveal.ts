// Fair reveal timing (docs/MILESTONE5.md §3–4): when a round's reveal time can
// be fixed, what that time is, when a late alarm counts as on time, and how a
// guess's own timing is trusted. Pure functions: no sockets, no state writes.

/** Legacy clients (no `hello`) get this long after the upload to receive the media. */
export const MEDIA_SETTLE_MS = 1_200;
/** Never hold a reveal longer than this after the upload for a slow connection. */
export const MEDIA_WAIT_MAX_MS = 4_000;
/** A fixed reveal time is at least this far ahead, so every client hears it in time. */
export const REVEAL_LEAD_MS = 800;
/** An alarm this late still reveals at the planned time; later, the reveal starts now. */
export const LATE_ALARM_MS = 1_000;
/** A client may say it saw the media at most this much earlier than the server measured. */
export const LAG_ALLOWANCE_MS = 1_000;
/** A guess sent just before time-up may still arrive this long after it. */
export const GUESS_GRACE_MS = 600;

export interface RevealPlayer {
  id: string;
  connected: boolean;
  fairReveal?: boolean;
}

/**
 * The connected non-owner players who said they can ack media (`fairReveal`)
 * but haven't acked this slot yet. The reveal waits for them, up to the cap.
 */
export function waitingOn(players: readonly RevealPlayer[], ownerID: string, loadedBy: readonly string[]): string[] {
  return players.filter((p) => p.connected && p.id !== ownerID && p.fairReveal === true && !loadedBy.includes(p.id)).map((p) => p.id);
}

/** True when the reveal time can be fixed now: everyone has the media, or we've waited long enough. */
export function canFixReveal(input: { now: number; readyAt: number; ownerID: string; players: readonly RevealPlayer[]; loadedBy: readonly string[] }): boolean {
  if (input.now >= input.readyAt + MEDIA_WAIT_MAX_MS) return true;
  return waitingOn(input.players, input.ownerID, input.loadedBy).length === 0;
}

/** When `tick` should look again while the reveal can't be fixed yet. */
export const revealWaitDeadline = (readyAt: number) => readyAt + MEDIA_WAIT_MAX_MS;

/**
 * The planned reveal time, fixed at `now`. The countdown always shows in
 * full; legacy clients still get the M4 settle time; fair clients get a lead
 * so the time reaches them before it arrives. With only legacy clients this is
 * exactly M4's `max(countdownStart + countdown, readyAt + settle)`.
 */
export function plannedRevealAt(input: {
  now: number;
  countdownStart: number;
  countdownMs: number;
  readyAt: number;
  ownerID: string;
  players: readonly RevealPlayer[];
}): number {
  const connected = input.players.filter((p) => p.connected);
  const legacyOthers = connected.some((p) => p.id !== input.ownerID && p.fairReveal !== true);
  const anyFair = connected.some((p) => p.fairReveal === true);
  return Math.max(
    input.countdownStart + input.countdownMs,
    legacyOthers ? input.readyAt + MEDIA_SETTLE_MS : 0,
    anyFair ? input.now + REVEAL_LEAD_MS : input.now,
  );
}

/** The reveal starts at the planned time unless the alarm ran very late. */
export function revealStart(due: number, now: number): number {
  return now - due <= LATE_ALARM_MS ? Math.min(due, now) : now;
}

/**
 * The elapsed time a guess is scored with. The server's own measure is the
 * ceiling; a fair client's measure (from when it actually showed the media)
 * is trusted down to `LAG_ALLOWANCE_MS` below it, so a slow connection costs
 * nothing and a lying client gains at most that much.
 */
export function acceptedElapsed(serverElapsed: number, claimed: unknown, fairReveal: boolean): number {
  const server = Math.max(0, serverElapsed);
  if (!fairReveal || typeof claimed !== 'number' || !Number.isFinite(claimed) || claimed < 0) return server;
  return Math.min(server, Math.max(server - LAG_ALLOWANCE_MS, claimed));
}
