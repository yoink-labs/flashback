// The Even Split schedule (docs/MILESTONE4.md §2). Decided once at `start`:
// every player owns an equal number of rounds (±1), each owner's rounds are
// split into kinds in the mode's proportion, and the order avoids showing two
// rounds by the same person back to back when it can.
//
// This is pure: players, rounds and randomness in; an ordered list out. It is
// never sent to clients, and nothing in it is allowed into a view.
import type { MediaKind, MediaMode } from './media';
import { shuffled, type FloatSource } from './random';

export interface ScheduledRound {
  ownerID: string;
  kind: MediaKind;
}

interface KindCounts {
  photo: number;
  video: number;
}

/**
 * 1. Each player owns `base` rounds, and `extra` random players own one more.
 * 2. In Mix an owner's `c` rounds are `round(c / 3)` videos and the rest photos;
 *    otherwise every round is the mode's kind.
 * 3. Order: among the owners with the most rounds left, pick one at random —
 *    avoiding the previous round's owner when possible — then take a random one
 *    of that owner's remaining kinds.
 */
export function evenSplitSchedule(rounds: number, players: readonly { id: string }[], mode: MediaMode, random: FloatSource): ScheduledRound[] {
  const ids = players.map((player) => player.id);
  if (!ids.length || rounds <= 0) return [];
  const base = Math.floor(rounds / ids.length);
  const extra = rounds % ids.length;
  const lucky = new Set(shuffled(ids, random).slice(0, extra));

  const remaining = new Map<string, KindCounts>();
  for (const id of ids) {
    const count = base + (lucky.has(id) ? 1 : 0);
    remaining.set(id, kindCounts(count, mode));
  }

  const schedule: ScheduledRound[] = [];
  let previous: string | null = null;
  for (let i = 0; i < rounds; i++) {
    const candidates: { id: string; left: number }[] = [];
    for (const id of ids) {
      const counts = remaining.get(id)!;
      const left = counts.photo + counts.video;
      if (left > 0) candidates.push({ id, left });
    }
    const most = Math.max(...candidates.map((candidate) => candidate.left));
    let pool = candidates.filter((candidate) => candidate.left === most).map((candidate) => candidate.id);
    const fresh = pool.filter((id) => id !== previous);
    if (fresh.length) pool = fresh;
    const ownerID = pool[Math.floor(random.float() * pool.length)];
    const counts = remaining.get(ownerID)!;
    const total = counts.photo + counts.video;
    const kind: MediaKind = Math.floor(random.float() * total) < counts.photo ? 'photo' : 'video';
    if (kind === 'photo') counts.photo -= 1;
    else counts.video -= 1;
    schedule.push({ ownerID, kind });
    previous = ownerID;
  }
  return schedule;
}

function kindCounts(count: number, mode: MediaMode): KindCounts {
  if (mode === 'photos') return { photo: count, video: 0 };
  if (mode === 'videos') return { photo: 0, video: count };
  const video = Math.round(count / 3);
  return { photo: count - video, video };
}
