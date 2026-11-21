import { describe, expect, it } from 'vitest';
import { PHOTO_BUNCH, VIDEO_BUNCH, bunchFor, deckFits, deckNeed } from '../src/bunch';

describe('the room bunch requirement', () => {
  it('uses the full M3 bunch when Even Split is off', () => {
    expect(bunchFor('photos', false, 10, 2)).toEqual({ photos: PHOTO_BUNCH, videos: 0 });
    expect(bunchFor('videos', false, 10, 2)).toEqual({ photos: 0, videos: VIDEO_BUNCH });
    expect(bunchFor('both', false, 10, 2)).toEqual({ photos: PHOTO_BUNCH, videos: VIDEO_BUNCH });
    // Players and rounds do not change the full bunch.
    expect(bunchFor('both', false, 100, 12)).toEqual({ photos: 12, videos: 6 });
  });

  it('splits rounds evenly when Even Split is on', () => {
    // share = ceil(rounds / players)
    expect(bunchFor('photos', true, 50, 5)).toEqual({ photos: 10, videos: 0 });
    expect(bunchFor('videos', true, 50, 9)).toEqual({ photos: 0, videos: 6 });
    expect(bunchFor('both', true, 7, 3)).toEqual({ photos: 2, videos: 1 });
    expect(bunchFor('both', true, 10, 4)).toEqual({ photos: 2, videos: 1 });
    expect(bunchFor('both', true, 100, 4)).toEqual({ photos: 17, videos: 8 });
    expect(bunchFor('both', true, 1, 2)).toEqual({ photos: 1, videos: 0 });
    expect(bunchFor('both', true, 2, 2)).toEqual({ photos: 1, videos: 0 });
    expect(bunchFor('both', true, 3, 2)).toEqual({ photos: 1, videos: 1 });
  });

  it('rounds the Mix video share to the nearest third', () => {
    const cases: [number, number, number, number][] = [
      // [share, expected photos, expected videos, label]
      [1, 1, 0, 'round(1/3)'],
      [2, 1, 1, 'round(2/3)'],
      [3, 2, 1, 'round(3/3)'],
      [4, 3, 1, 'round(4/3)'],
      [5, 3, 2, 'round(5/3)'],
      [6, 4, 2, 'round(6/3)'],
      [8, 5, 3, 'round(8/3)'],
      [10, 7, 3, 'round(10/3)'],
      [25, 17, 8, 'round(25/3)'],
    ];
    for (const [share, photos, videos, label] of cases) {
      expect(bunchFor('both', true, share, 1), label).toEqual({ photos, videos });
    }
  });

  it('treats an empty room as one player and never asks for zero rounds', () => {
    expect(bunchFor('photos', true, 5, 0)).toEqual({ photos: 5, videos: 0 });
    expect(bunchFor('both', true, 0, 3)).toEqual({ photos: 0, videos: 0 });
  });
});

describe('deckFits', () => {
  it('needs every required item of each kind', () => {
    const bunch = { photos: 3, videos: 2 };
    expect(deckFits({ photos: 3, videos: 2 }, bunch)).toBe(true);
    expect(deckFits({ photos: 8, videos: 9 }, bunch)).toBe(true);
    expect(deckFits({ photos: 2, videos: 2 }, bunch)).toBe(false);
    expect(deckFits({ photos: 3, videos: 1 }, bunch)).toBe(false);
    expect(deckFits({ photos: 0, videos: 0 }, bunch)).toBe(false);
  });

  it('ignores a kind the room does not need', () => {
    expect(deckFits({ photos: 5, videos: 0 }, { photos: 5, videos: 0 })).toBe(true);
    expect(deckFits({ photos: 0, videos: 5 }, { photos: 0, videos: 5 })).toBe(true);
    expect(deckFits({ photos: 0, videos: 0 }, { photos: 0, videos: 0 })).toBe(true);
  });
});

describe('deckNeed', () => {
  it('words the full bunch as one task', () => {
    expect(deckNeed({ photos: 0, videos: 0 }, { photos: 12, videos: 6 })).toBe('Deal 12 photos and 6 videos');
    expect(deckNeed({ photos: 0, videos: 0 }, { photos: 12, videos: 0 })).toBe('Deal 12 photos');
    expect(deckNeed({ photos: 0, videos: 0 }, { photos: 0, videos: 6 })).toBe('Deal 6 videos');
  });

  it('names only what is missing, in singular when it is one', () => {
    expect(deckNeed({ photos: 10, videos: 0 }, { photos: 12, videos: 6 })).toBe('Add 2 more photos and Deal 6 videos');
    expect(deckNeed({ photos: 12, videos: 4 }, { photos: 12, videos: 6 })).toBe('Add 2 more videos');
    expect(deckNeed({ photos: 11, videos: 5 }, { photos: 12, videos: 6 })).toBe('Add 1 more photo and Add 1 more video');
    expect(deckNeed({ photos: 0, videos: 0 }, { photos: 1, videos: 0 })).toBe('Deal 1 photo');
    expect(deckNeed({ photos: 0, videos: 0 }, { photos: 0, videos: 1 })).toBe('Deal 1 video');
    expect(deckNeed({ photos: 0, videos: 0 }, { photos: 2, videos: 1 })).toBe('Deal 2 photos and 1 video');
  });

  it('is quiet when the bunch fits', () => {
    expect(deckNeed({ photos: 12, videos: 6 }, { photos: 12, videos: 6 })).toBeNull();
    expect(deckNeed({ photos: 50, videos: 50 }, { photos: 3, videos: 1 })).toBeNull();
    expect(deckNeed({ photos: 0, videos: 0 }, { photos: 0, videos: 0 })).toBeNull();
  });
});
