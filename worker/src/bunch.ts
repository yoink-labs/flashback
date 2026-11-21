// The bunch rules every player plays by: the same number of photos and videos
// each (so nobody's camera roll is over-represented), what a short bunch still
// needs, and how Mix rounds split between photos and videos.
import type { MediaKind, MediaMode } from './media';

/** Every player's bunch holds this many photos and this many videos (Mix needs both). */
export const PHOTO_BUNCH = 12;
export const VIDEO_BUNCH = 6;

/** Counts of the items a player currently has in their local bunches. */
export interface Deck {
  photos: number;
  videos: number;
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

/** Whether a deck has a full bunch for the mode. */
export const deckFits = (deck: Deck, mode: MediaMode) =>
  mode === 'photos'
    ? deck.photos >= PHOTO_BUNCH
    : mode === 'videos'
      ? deck.videos >= VIDEO_BUNCH
      : deck.photos >= PHOTO_BUNCH && deck.videos >= VIDEO_BUNCH;

/**
 * What one player's deck still needs, worded as their next task: "Deal 12
 * photos" when the bunch is empty, "Add 2 more videos" when it is short, and
 * the two joined with " and " in Mix.
 */
export function deckNeed(deck: Deck, mode: MediaMode): string | null {
  const parts: { deal: boolean; text: string }[] = [];
  if (mode !== 'videos') {
    const missing = Math.max(0, PHOTO_BUNCH - deck.photos);
    if (missing === PHOTO_BUNCH) parts.push({ deal: true, text: `${PHOTO_BUNCH} photos` });
    else if (missing > 0) parts.push({ deal: false, text: `${missing} more photo${missing === 1 ? '' : 's'}` });
  }
  if (mode !== 'photos') {
    const missing = Math.max(0, VIDEO_BUNCH - deck.videos);
    if (missing === VIDEO_BUNCH) parts.push({ deal: true, text: `${VIDEO_BUNCH} videos` });
    else if (missing > 0) parts.push({ deal: false, text: `${missing} more video${missing === 1 ? '' : 's'}` });
  }
  if (!parts.length) return null;
  if (parts.every((part) => part.deal)) return `Deal ${parts.map((part) => part.text).join(' and ')}`;
  return parts.map((part) => (part.deal ? `Deal ${part.text}` : `Add ${part.text}`)).join(' and ');
}
