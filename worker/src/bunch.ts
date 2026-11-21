// The bunch rules every player plays by: how many items of each kind a player
// must deal, what a short bunch still needs, and how Mix rounds split between
// photos and videos. docs/MILESTONE3.md §7 and MILESTONE4.md §2.
import type { MediaKind, MediaMode } from './media';

/** A full bunch in a room without Even Split. */
export const PHOTO_BUNCH = 12;
export const VIDEO_BUNCH = 6;

/** Counts of the items a player currently has in their local bunches. */
export interface Deck {
  photos: number;
  videos: number;
}

/** How many of each kind one player must deal for this room. */
export interface BunchRequirement {
  photos: number;
  videos: number;
}

/**
 * The room's bunch requirement. Without Even Split every player deals the full
 * bunch. With it, each player deals `ceil(rounds / players)` items, split in
 * Mix so every one of their rounds has an item.
 */
export function bunchFor(mode: MediaMode, evenSplit: boolean, rounds: number, players: number): BunchRequirement {
  if (!evenSplit) {
    if (mode === 'photos') return { photos: PHOTO_BUNCH, videos: 0 };
    if (mode === 'videos') return { photos: 0, videos: VIDEO_BUNCH };
    return { photos: PHOTO_BUNCH, videos: VIDEO_BUNCH };
  }
  const share = Math.ceil(rounds / Math.max(players, 1));
  if (mode === 'photos') return { photos: share, videos: 0 };
  if (mode === 'videos') return { photos: 0, videos: share };
  const videos = Math.round(share / 3);
  return { photos: share - videos, videos };
}

/** The kind of each round, with photos and videos in proportion to their bunch sizes. */
export function balancedRoundKinds(rounds: number, mode: MediaMode, random: { float(): number }): MediaKind[] {
  if (mode === 'photos') return Array.from({ length: rounds }, () => 'photo' as const);
  if (mode === 'videos') return Array.from({ length: rounds }, () => 'video' as const);
  const photos = Math.round((rounds * PHOTO_BUNCH) / (PHOTO_BUNCH + VIDEO_BUNCH));
  const kinds: MediaKind[] = [
    ...Array.from({ length: photos }, () => 'photo' as const),
    ...Array.from({ length: rounds - photos }, () => 'video' as const),
  ];
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(random.float() * (i + 1));
    const swap = kinds[i];
    kinds[i] = kinds[j];
    kinds[j] = swap;
  }
  return kinds;
}

/** Whether a deck has the room's full bunch. */
export const deckFits = (deck: Deck, bunch: BunchRequirement) => deck.photos >= bunch.photos && deck.videos >= bunch.videos;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const more = (count: number, noun: string) => `${count} more ${noun}${count === 1 ? '' : 's'}`;

/**
 * What one player's deck still needs, worded as their next task: "Deal 12
 * photos" when the bunch is empty, "Add 2 more videos" when it is short, and
 * the two joined with " and " in Mix.
 */
export function deckNeed(deck: Deck, bunch: BunchRequirement): string | null {
  const parts: { deal: boolean; text: string }[] = [];
  if (bunch.photos > 0) {
    const missing = Math.max(0, bunch.photos - deck.photos);
    if (missing === bunch.photos) parts.push({ deal: true, text: plural(bunch.photos, 'photo') });
    else if (missing > 0) parts.push({ deal: false, text: more(missing, 'photo') });
  }
  if (bunch.videos > 0) {
    const missing = Math.max(0, bunch.videos - deck.videos);
    if (missing === bunch.videos) parts.push({ deal: true, text: plural(bunch.videos, 'video') });
    else if (missing > 0) parts.push({ deal: false, text: more(missing, 'video') });
  }
  if (!parts.length) return null;
  if (parts.every((part) => part.deal)) return `Deal ${parts.map((part) => part.text).join(' and ')}`;
  return parts.map((part) => (part.deal ? `Deal ${part.text}` : `Add ${part.text}`)).join(' and ');
}
