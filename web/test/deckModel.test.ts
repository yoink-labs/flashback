// Pure bunch rules (src/deckModel.ts). Run with `npm test --prefix web`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as deck from '../src/deckModel.ts';
import type { DeckModel } from '../src/deckModel.ts';
import type { MediaKind } from '../src/types.ts';

let fileSeq = 0;
const photo = (name = `p${fileSeq++}.jpg`) => new File(['x'], name, { type: 'image/jpeg', lastModified: 1 });
const video = (name = `v${fileSeq++}.mp4`) => new File(['x'], name, { type: 'video/mp4', lastModified: 1 });
const kindOf = (file: File): MediaKind | null => (file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'photo' : null);
let idSeq = 0;
const newID = () => `i${idSeq++}`;

function dealt(photos: number, videos = 0): DeckModel {
  const files = [...Array.from({ length: photos }, () => photo()), ...Array.from({ length: videos }, () => video())];
  return deck.addFiles(deck.EMPTY_DECK, files, kindOf, newID)[0];
}

test('picking deals each kind into its own bunch and reports what happened', () => {
  const files = [...Array.from({ length: 20 }, () => photo()), ...Array.from({ length: 4 }, () => video()), new File(['x'], 'notes.txt', { type: 'text/plain' })];
  const [model, summary] = deck.addFiles(deck.EMPTY_DECK, files, kindOf, newID);
  assert.equal(model.photo.ids.length, 12);
  assert.equal(model.video.ids.length, 4);
  assert.deepEqual(summary, { added: 24, photos: 20, videos: 4, skipped: 0, duplicates: 0, ignored: 1 });
  assert.equal(deck.bunchView(model, 'video', 3).full, false);

  // Picking the same files again adds nothing; more videos top the bunch up.
  const [again, repeat] = deck.addFiles(model, [files[0], video(), video()], kindOf, newID);
  assert.equal(repeat.duplicates, 1);
  assert.equal(again.video.ids.length, 6);
  assert.deepEqual(again.photo.ids, model.photo.ids, 'a full bunch is left alone');
});

test('the pool is capped', () => {
  const [model, summary] = deck.addFiles(deck.EMPTY_DECK, Array.from({ length: deck.MAX_POOL + 5 }, () => photo()), kindOf, newID);
  assert.equal(model.pool.length, deck.MAX_POOL);
  assert.equal(summary.skipped, 5);
});

test('300 picks stay cheap', () => {
  const files = Array.from({ length: 300 }, (_, i) => (i % 5 ? photo() : video()));
  const started = performance.now();
  const [model] = deck.addFiles(deck.EMPTY_DECK, files, kindOf, newID);
  let next = model;
  for (let i = 0; i < 50; i++) next = deck.newBunch(next, 'photo');
  assert.ok(performance.now() - started < 500);
  assert.equal(next.photo.ids.length, 12);
});

test('a swap replaces one tile, costs one swap, and stops at the limit', () => {
  let model = dealt(30);
  const before = model.photo.ids;
  let result: deck.SwapResult;
  [model, result] = deck.swap(model, 'photo', 4, 2);
  assert.equal(result, 'swapped');
  assert.notEqual(model.photo.ids[4], before[4]);
  assert.deepEqual(model.photo.ids.filter((_, i) => i !== 4), before.filter((_, i) => i !== 4));
  assert.ok(model.vetoed.has(before[4]));
  [model] = deck.swap(model, 'photo', 0, 2);
  [model, result] = deck.swap(model, 'photo', 1, 2);
  assert.equal(result, 'no-swaps');
  assert.equal(deck.bunchView(model, 'photo', 2).swapsLeft, 0);
  // The host lowers swaps after they were used: clamps to zero, never negative.
  assert.equal(deck.bunchView(model, 'photo', 1).swapsLeft, 0);
  assert.equal(deck.bunchView(model, 'photo', 5).swapsLeft, 3);
});

test('swapped-out items come back only when nothing else is left', () => {
  let model = dealt(13);
  const out = model.photo.ids[0];
  [model] = deck.swap(model, 'photo', 0, 10);
  assert.ok(!model.photo.ids.includes(out));
  // Only the swapped-out item is outside the bunch now.
  [model] = deck.swap(model, 'photo', 3, 10);
  assert.equal(model.photo.ids[3], out);
});

test('no swap without anything to swap in', () => {
  const model = dealt(12);
  const [same, result] = deck.swap(model, 'photo', 0, 3);
  assert.equal(result, 'no-pool');
  assert.equal(same, model);
  assert.equal(deck.bunchView(model, 'photo', 3).canSwap, false);
});

test('a new bunch prefers items not in the current one and resets swaps', () => {
  let model = dealt(24);
  [model] = deck.swap(model, 'photo', 0, 3);
  const previous = new Set(model.photo.ids);
  model = deck.newBunch(model, 'photo');
  assert.equal(model.photo.swapsUsed, 0);
  assert.equal(model.photo.ids.length, 12);
  assert.ok(model.photo.ids.every((id) => !previous.has(id)));
});

test('a new bunch from a small pool keeps a full bunch', () => {
  const model = deck.newBunch(dealt(14), 'photo');
  assert.equal(new Set(model.photo.ids).size, 12);
});

test('an unreadable item is replaced for free, or leaves a gap, and never returns', () => {
  let model = dealt(13);
  const bad = model.photo.ids[2];
  model = deck.markFailed(model, bad);
  assert.equal(model.photo.ids.length, 12);
  assert.ok(!model.photo.ids.includes(bad));
  assert.equal(model.photo.swapsUsed, 0);
  model = deck.markFailed(model, model.photo.ids[5]);
  assert.equal(model.photo.ids.length, 11, 'nothing left to deal');
  assert.equal(deck.deckCounts(model, 'photos', true).photos, 11);
  model = deck.newBunch(model, 'photo');
  assert.ok(!model.photo.ids.includes(bad));
  assert.equal(deck.bunchView(model, 'photo', 3).poolSize, 11);
});

test('candidates are unused bunch items, recycled once all are shown', () => {
  let model = dealt(12);
  const shown = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const [next, item] = deck.pickCandidate(model, 'photo');
    assert.ok(item && !shown.has(item.id));
    shown.add(item.id);
    model = deck.setUsed(next, new Set([item.id]), true);
    assert.ok(!deck.isUsable(model, item.id, 'photo'));
  }
  const [recycled, again] = deck.pickCandidate(model, 'photo');
  assert.ok(again);
  assert.ok(deck.isUsable(recycled, again.id, 'photo'));
});

test('a swapped-out prepared item is no longer usable', () => {
  let model = dealt(20);
  const [, item] = deck.pickCandidate(model, 'photo');
  const slot = model.photo.ids.indexOf(item!.id);
  [model] = deck.swap(model, 'photo', slot, 3);
  assert.ok(!deck.isUsable(model, item!.id, 'photo'));
});

test('counts and fit follow the mode, like the server', () => {
  const model = dealt(15, 6);
  assert.deepEqual(deck.deckCounts(model, 'photos', true), { photos: 12, videos: 0 });
  assert.deepEqual(deck.deckCounts(model, 'videos', true), { photos: 0, videos: 6 });
  assert.deepEqual(deck.deckCounts(model, 'both', true), { photos: 12, videos: 6 });
  assert.ok(deck.deckFits(deck.deckCounts(model, 'both', true), 'both'));
  // A browser that can't convert clips can't offer any.
  assert.deepEqual(deck.deckCounts(model, 'both', false), { photos: 12, videos: 0 });
  assert.ok(!deck.deckFits(deck.deckCounts(model, 'both', false), 'both'));
  assert.ok(deck.deckFits(deck.deckCounts(model, 'photos', false), 'photos'));
  assert.ok(!deck.deckFits(deck.deckCounts(dealt(12, 4), 'both', true), 'both'));
});

test('switching modes keeps both bunches', () => {
  const model = dealt(12, 6);
  for (const mode of ['photos', 'both', 'videos'] as const) assert.equal(deck.kindsFor(mode).length, mode === 'both' ? 2 : 1);
  assert.equal(deck.bunchView(model, 'photo', 3).full, true);
  assert.equal(deck.bunchView(model, 'video', 3).full, true);
});

test('a reload restores the bunches and remembers what was seen or swapped out', () => {
  const files = Array.from({ length: 14 }, () => photo());
  let [model] = deck.addFiles(deck.EMPTY_DECK, files, kindOf, newID);
  const out = model.photo.ids[0];
  const outFile = model.pool.find((item) => item.id === out)!.file;
  [model] = deck.swap(model, 'photo', 0, 3);
  const stored = deck.snapshot(model);
  assert.equal(stored.items.length, 12, 'only bunch files are stored');

  let restored = deck.restore(stored);
  assert.deepEqual(restored.photo, model.photo);
  // The player picks the same files again: the swapped-out one is still last in line.
  [restored] = deck.addFiles(restored, files, kindOf, newID);
  assert.equal(restored.pool.length, 14);
  const outAgain = restored.pool.find((item) => item.file === outFile)!;
  assert.ok(restored.vetoed.has(outAgain.id));
  [restored] = deck.swap(restored, 'photo', 1, 3);
  assert.notEqual(restored.photo.ids[1], outAgain.id);
});
