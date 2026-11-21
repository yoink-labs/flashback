// The server clock (docs/MILESTONE5.md §2). Local time is monotonic —
// `performance.timeOrigin + performance.now()` — so a phone that corrects its
// wall clock mid-round does not move the reveal. The offset comes from the
// lowest-RTT ping sample of the last 8; until the first pong it falls back to
// `state.serverNow − localNow`, exactly as M4 did.
import { bestOffset, pongSample, pushClockSample, type ClockSample } from './fair';

/** Monotonic local milliseconds, anchored to wall time once at page load. */
export function localNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.timeOrigin === 'number') return performance.timeOrigin + performance.now();
  return Date.now();
}

export class ServerClock {
  private samples: ClockSample[] = [];
  /** `state.serverNow − localNow`, updated on every state until a pong lands. */
  private fallback: number | null = null;
  /** Pings awaiting their pong: id → local send time. */
  private pending = new Map<number, number>();
  private nextID = 1;

  /**
   * A new socket: forget pings that can no longer be answered and this
   * connection's samples. The last known offset stays until fresh pongs land.
   */
  beginConnection() {
    this.pending.clear();
    this.samples = [];
  }

  /** Reserves an id and records t0; send `{ type: 'ping', id }` with it. */
  pingID(): number {
    const id = this.nextID++;
    this.pending.set(id, localNow());
    return id;
  }

  /** A pong for one of our pings. Ids we did not send (or already used) are ignored. */
  notePong(id: number, serverNow: number) {
    const t0 = this.pending.get(id);
    if (t0 === undefined || !Number.isFinite(serverNow)) return;
    this.pending.delete(id);
    this.samples = pushClockSample(this.samples, pongSample(t0, localNow(), serverNow));
  }

  /** M4's fallback: the offset carried by every state message. */
  noteState(serverNow: number) {
    if (Number.isFinite(serverNow)) this.fallback = serverNow - localNow();
  }

  synced(): boolean {
    return this.samples.length > 0;
  }

  offset(): number {
    return bestOffset(this.samples) ?? this.fallback ?? 0;
  }

  /** Every timer, effect and reveal in the app reads this. */
  serverNow(): number {
    return localNow() + this.offset();
  }
}
