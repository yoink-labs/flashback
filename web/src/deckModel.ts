// The player's pool and bunches as one immutable value with pure transitions
// (docs/MILESTONE3.md §1, §7, §8). Everything that decides *what* is in a bunch
// lives here; `useDeck` (deck.ts) only orchestrates: it holds the current model,
// runs the async work (thumbnails, preparing, uploads) and reports counts.
//
// The picked files are the *pool*. Each kind has its own bunch (12 photos,
// 6 videos) dealt at random from that kind's pool. A swap replaces one tile and
// costs one of `settings.swaps`; a new bunch re-deals and resets the swaps.
// Draw order: never seen this session, then seen, then swapped out ("vetoed").
// Items that turned out unreadable ("failed") are never drawn again and are
// replaced for free.
//
// No DOM or React here, so it runs under `node --test` (web/test).
import type { DeckCounts, MediaKind, MediaMode } from './types';

export const PHOTO_BUNCH = 12;
export const VIDEO_BUNCH = 6;
export const BUNCH_SIZE: Record<MediaKind, number> = { photo: PHOTO_BUNCH, video: VIDEO_BUNCH };
export const MAX_POOL = 400;
export const KINDS: readonly MediaKind[] = ['photo', 'video'];

export interface DeckItem {
  id: string;
  file: File;
  kind: MediaKind;
  /** Already shown (or on its way) this game. Not offered again until the bunch recycles. */
  used: boolean;
}

export interface Bunch {
  /** Item ids in tile order; at most BUNCH_SIZE[kind]. */
  ids: string[];
  /** Swaps spent since the last deal. Remaining = settings.swaps − this, so a lowered setting clamps itself. */
  swapsUsed: number;
}

export interface DeckModel {
  pool: DeckItem[];
  photo: Bunch;
  video: Bunch;
  /** Item ids dealt into a bunch this session. */
  seen: ReadonlySet<string>;
  /** Item ids the player swapped out: drawn again only when nothing else is left. */
  vetoed: ReadonlySet<string>;
  /** Item ids this browser could not open or the server refused: never drawn again. */
  failed: ReadonlySet<string>;
  /** Fingerprints seen / swapped out before a reload, applied to files picked again. */
  carried: { seen: ReadonlySet<string>; vetoed: ReadonlySet<string> };
}

export type Random = () => number;
export type SwapResult = 'swapped' | 'no-swaps' | 'no-pool';

export const EMPTY_DECK: DeckModel = {
  pool: [],
  photo: { ids: [], swapsUsed: 0 },
  video: { ids: [], swapsUsed: 0 },
  seen: new Set(),
  vetoed: new Set(),
  failed: new Set(),
  carried: { seen: new Set(), vetoed: new Set() },
};

/** Identifies a picked file across reloads (item ids are per session). */
export const fingerprint = (file: File) => `${file.name}|${file.size}|${file.lastModified}`;

export const fitsMode = (kind: MediaKind, mode: MediaMode) => mode === 'both' || (mode === 'photos' ? kind === 'photo' : kind === 'video');

/** The kinds a mode needs, in review-step order. */
export const kindsFor = (mode: MediaMode): MediaKind[] => KINDS.filter((kind) => fitsMode(kind, mode));

/** Mirrors the server's `deckFits` (worker/src/bunch.ts). */
export const deckFits = (counts: DeckCounts, mode: MediaMode) =>
  (!fitsMode('photo', mode) || counts.photos >= PHOTO_BUNCH) && (!fitsMode('video', mode) || counts.videos >= VIDEO_BUNCH);

export function shuffled<T>(list: readonly T[], random: Random = Math.random): T[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const union = (set: ReadonlySet<string>, more: Iterable<string>) => new Set([...set, ...more]);

/**
 * Up to `count` random pool items of `kind` outside `exclude`, best tier first:
 * never seen, then seen, then swapped out. Failed items are never drawn. The
 * drawn ids count as seen.
 */
function draw(model: DeckModel, kind: MediaKind, count: number, exclude: ReadonlySet<string>, random: Random): [DeckModel, string[]] {
  if (count <= 0) return [model, []];
  const tiers: string[][] = [[], [], []];
  for (const item of model.pool) {
    if (item.kind !== kind || exclude.has(item.id) || model.failed.has(item.id)) continue;
    tiers[model.vetoed.has(item.id) ? 2 : model.seen.has(item.id) ? 1 : 0].push(item.id);
  }
  const picked = tiers.flatMap((tier) => shuffled(tier, random)).slice(0, count);
  return [picked.length ? { ...model, seen: union(model.seen, picked) } : model, picked];
}

/** Deals into any empty slots of either bunch. A bunch dealt from empty starts with fresh swaps. */
function fillEmptySlots(model: DeckModel, random: Random): DeckModel {
  let next = model;
  for (const kind of KINDS) {
    const bunch = next[kind];
    const [drawn, fill] = draw(next, kind, BUNCH_SIZE[kind] - bunch.ids.length, new Set(bunch.ids), random);
    if (fill.length) next = { ...drawn, [kind]: { ids: [...bunch.ids, ...fill], swapsUsed: bunch.ids.length ? bunch.swapsUsed : 0 } };
  }
  return next;
}

export interface AddSummary {
  added: number;
  photos: number;
  videos: number;
  /** Over MAX_POOL. */
  skipped: number;
  duplicates: number;
  /** Not a photo or video. */
  ignored: number;
}

/**
 * Adds picked files to the pool (each to its own kind, whatever step it was
 * picked from) and deals into any empty bunch slots. Cheap: nothing is decoded.
 */
export function addFiles(
  model: DeckModel,
  files: readonly File[],
  kindOf: (file: File) => MediaKind | null,
  newID: () => string,
  random: Random = Math.random,
): [DeckModel, AddSummary] {
  const media = files.flatMap((file) => {
    const kind = kindOf(file);
    return kind ? [{ file, kind }] : [];
  });
  // Picking the same files again (e.g. after a reload) must not duplicate tiles.
  const have = new Set(model.pool.map((item) => fingerprint(item.file)));
  const fresh = media.filter(({ file }) => {
    const print = fingerprint(file);
    if (have.has(print)) return false;
    have.add(print);
    return true;
  });
  const accepted = fresh.slice(0, Math.max(0, MAX_POOL - model.pool.length));
  const summary: AddSummary = {
    added: accepted.length,
    photos: accepted.filter((entry) => entry.kind === 'photo').length,
    videos: accepted.filter((entry) => entry.kind === 'video').length,
    skipped: fresh.length - accepted.length,
    duplicates: media.length - fresh.length,
    ignored: files.length - media.length,
  };
  if (!accepted.length) return [model, summary];

  const added: DeckItem[] = accepted.map(({ file, kind }) => ({ id: newID(), file, kind, used: false }));
  const carriedSeen = added.filter((item) => model.carried.seen.has(fingerprint(item.file))).map((item) => item.id);
  const carriedVetoed = added.filter((item) => model.carried.vetoed.has(fingerprint(item.file))).map((item) => item.id);
  const grown: DeckModel = {
    ...model,
    pool: [...model.pool, ...added],
    seen: union(model.seen, carriedSeen),
    vetoed: union(model.vetoed, carriedVetoed),
  };
  return [fillEmptySlots(grown, random), summary];
}

/** Replaces one tile with another random item of its kind, using one of `allowed` swaps. */
export function swap(model: DeckModel, kind: MediaKind, slot: number, allowed: number, random: Random = Math.random): [DeckModel, SwapResult] {
  const bunch = model[kind];
  if (slot < 0 || slot >= bunch.ids.length) return [model, 'no-pool'];
  if (bunch.swapsUsed >= allowed) return [model, 'no-swaps'];
  const [drawn, [next]] = draw(model, kind, 1, new Set(bunch.ids), random);
  if (!next) return [model, 'no-pool'];
  const ids = [...bunch.ids];
  const out = ids[slot];
  ids[slot] = next;
  return [{ ...drawn, vetoed: union(drawn.vetoed, [out]), [kind]: { ids, swapsUsed: bunch.swapsUsed + 1 } }, 'swapped'];
}

/** Deals a fresh bunch of one kind (as fresh as the pool allows) and resets its swaps. */
export function newBunch(model: DeckModel, kind: MediaKind, random: Random = Math.random): DeckModel {
  const current = new Set(model[kind].ids);
  const usable = model.pool.filter((item) => item.kind === kind && !model.failed.has(item.id)).length;
  const size = Math.min(BUNCH_SIZE[kind], usable);
  // Everything not in the current bunch first; top up from it only when the pool is small.
  const [afterFresh, fresh] = draw(model, kind, size, current, random);
  const [afterRest, rest] = draw(afterFresh, kind, size - fresh.length, new Set(fresh), random);
  return { ...afterRest, [kind]: { ids: shuffled([...fresh, ...rest], random), swapsUsed: 0 } };
}

/**
 * This browser can't open an item (or the server refused it): never draw it
 * again, and refill its tile for free when the pool has another one.
 */
export function markFailed(model: DeckModel, id: string, random: Random = Math.random): DeckModel {
  if (model.failed.has(id)) return model;
  const item = model.pool.find((candidate) => candidate.id === id);
  const next: DeckModel = { ...model, failed: union(model.failed, [id]) };
  const bunch = item && next[item.kind];
  if (!item || !bunch?.ids.includes(id)) return next;
  const [drawn, [replacement]] = draw(next, item.kind, 1, new Set(bunch.ids), random);
  const ids = replacement ? bunch.ids.map((existing) => (existing === id ? replacement : existing)) : bunch.ids.filter((existing) => existing !== id);
  return { ...drawn, [item.kind]: { ...bunch, ids } };
}

export const setUsed = (model: DeckModel, ids: ReadonlySet<string>, used: boolean): DeckModel => ({
  ...model,
  pool: model.pool.map((item) => (ids.has(item.id) && item.used !== used ? { ...item, used } : item)),
});

/** The bunch's items in tile order. */
export function bunchItems(model: DeckModel, kind: MediaKind): DeckItem[] {
  const byID = new Map(model.pool.map((item) => [item.id, item]));
  return model[kind].ids.flatMap((id) => byID.get(id) ?? []);
}

/** An item still eligible to be prepared and uploaded: in its bunch, unused, readable. */
export function isUsable(model: DeckModel, id: string, kind: MediaKind) {
  if (!model[kind].ids.includes(id) || model.failed.has(id)) return false;
  const item = model.pool.find((candidate) => candidate.id === id);
  return Boolean(item && item.kind === kind && !item.used);
}

/**
 * One random unused bunch item of `kind` to prepare. When every one has been
 * shown, the used marks are cleared so the bunch recycles.
 */
export function pickCandidate(model: DeckModel, kind: MediaKind, random: Random = Math.random): [DeckModel, DeckItem | null] {
  const candidates = bunchItems(model, kind).filter((item) => !model.failed.has(item.id));
  if (!candidates.length) return [model, null];
  const fresh = candidates.filter((item) => !item.used);
  if (fresh.length) return [model, fresh[Math.floor(random() * fresh.length)]];
  const recycled = setUsed(model, new Set(candidates.map((item) => item.id)), false);
  const pick = candidates[Math.floor(random() * candidates.length)];
  return [recycled, { ...pick, used: false }];
}

export interface BunchView {
  kind: MediaKind;
  size: number;
  items: DeckItem[];
  /** Readable pool items of this kind. */
  poolSize: number;
  swapsLeft: number;
  /** Whether a swap or new bunch could bring in anything new at all. */
  canSwap: boolean;
  full: boolean;
}

export function bunchView(model: DeckModel, kind: MediaKind, swaps: number): BunchView {
  const items = bunchItems(model, kind);
  const poolSize = model.pool.reduce((count, item) => count + (item.kind === kind && !model.failed.has(item.id) ? 1 : 0), 0);
  return {
    kind,
    size: BUNCH_SIZE[kind],
    items,
    poolSize,
    swapsLeft: Math.max(0, swaps - model[kind].swapsUsed),
    canSwap: poolSize > items.length,
    full: items.length >= BUNCH_SIZE[kind],
  };
}

/**
 * What the server is told: the bunches that fit the mode, capped at the bunch
 * size. Videos count only when this browser can convert them.
 */
export function deckCounts(model: DeckModel, mode: MediaMode, canSendVideos: boolean): DeckCounts {
  const count = (kind: MediaKind) => Math.min(BUNCH_SIZE[kind], model[kind].ids.filter((id) => !model.failed.has(id)).length);
  return {
    photos: fitsMode('photo', mode) ? count('photo') : 0,
    videos: fitsMode('video', mode) && canSendVideos ? count('video') : 0,
  };
}

// ---- persistence (deckStore.ts) ----

export type StoredItem = DeckItem;

export interface StoredDeck {
  items: StoredItem[];
  photo: Bunch;
  video: Bunch;
  /** Fingerprints of items seen / swapped out this session. */
  seen: string[];
  vetoed: string[];
}

/** Only the bunch files are kept (at most 12 + 6), never the whole pool. Failed items are never in a bunch. */
export function snapshot(model: DeckModel): StoredDeck {
  const inBunch = new Set([...model.photo.ids, ...model.video.ids]);
  const prints = (ids: ReadonlySet<string>, carried: ReadonlySet<string>) => {
    const out = new Set(carried);
    for (const item of model.pool) if (ids.has(item.id)) out.add(fingerprint(item.file));
    return [...out];
  };
  return {
    items: model.pool.filter((item) => inBunch.has(item.id)),
    photo: model.photo,
    video: model.video,
    seen: prints(model.seen, model.carried.seen),
    vetoed: prints(model.vetoed, model.carried.vetoed),
  };
}

/** The model a stored deck describes. */
export function restore(stored: StoredDeck): DeckModel {
  const present = new Set(stored.items.map((item) => item.id));
  const bunch = (b: Bunch): Bunch => ({ ids: b.ids.filter((id) => present.has(id)), swapsUsed: b.swapsUsed });
  return {
    pool: stored.items.map(({ id, file, kind, used }) => ({ id, file, kind, used })),
    photo: bunch(stored.photo),
    video: bunch(stored.video),
    seen: new Set(present),
    vetoed: new Set(),
    failed: new Set(),
    carried: { seen: new Set(stored.seen), vetoed: new Set(stored.vetoed) },
  };
}
