// Keeps the player's current bunches across a tab reload (iOS Safari often
// discards a background tab while the player shares the invite). Only the bunch
// files are kept (at most 12 photos + 6 videos), never the whole pool, plus the
// swap counters and the seen / swapped-out bookkeeping (see `snapshot` in
// deckModel.ts).
//
// Stored per room + player in IndexedDB as Blobs. Writes are debounced and
// flushed when the tab is hidden; any failure (private mode, quota) silently
// turns persistence off and the deck stays memory-only. Entries older than six
// hours are swept on app start; leaving / closing the room deletes the entry.
import { useCallback, useEffect, useRef } from 'react';
import type { StoredDeck, StoredItem } from './deckModel';

interface DeckRecord extends Omit<StoredDeck, 'items'> {
  key: string;
  savedAt: number;
  items: Omit<StoredItem, 'file'>[];
}

interface FileRecord {
  key: string;
  deck: string;
  savedAt: number;
  file: Blob;
  name: string;
  type: string;
  lastModified: number;
}

const DB_NAME = 'flashback-deck';
const DECKS = 'decks';
const FILES = 'files';
const MAX_AGE_MS = 6 * 60 * 60_000;
const DEBOUNCE_MS = 600;

export const deckKey = (code: string, playerID: string) => `${code}:${playerID}`;
const fileKey = (deck: string, id: string) => `${deck}|${id}`;
const fileRange = (deck: string) => IDBKeyRange.bound(`${deck}|`, `${deck}|￿`);

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DECKS)) db.createObjectStore(DECKS, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Runs `work` in one transaction and resolves when it commits. */
async function run<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => T): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([DECKS, FILES], mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
    try {
      result = work(tx);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function load(key: string): Promise<StoredDeck | null> {
  const db = await openDB();
  const tx = db.transaction([DECKS, FILES], 'readonly');
  // Both requests up front: the transaction must not go idle between them.
  const [record, files] = (await Promise.all([request(tx.objectStore(DECKS).get(key)), request(tx.objectStore(FILES).getAll(fileRange(key)))])) as [
    DeckRecord | undefined,
    FileRecord[],
  ];
  if (!record || Date.now() - record.savedAt > MAX_AGE_MS) return null;
  const byID = new Map(files.map((entry) => [entry.key.slice(key.length + 1), entry]));
  const items: StoredItem[] = [];
  for (const item of record.items) {
    const entry = byID.get(item.id);
    if (!entry) continue;
    const file =
      entry.file instanceof File ? entry.file : new File([entry.file], entry.name, { type: entry.type, lastModified: entry.lastModified });
    items.push({ ...item, file });
  }
  return { items, photo: record.photo, video: record.video, seen: record.seen ?? [], vetoed: record.vetoed ?? [] };
}

/** Writes the deck. Files already stored (`written`) are not rewritten; dropped ones are deleted. */
async function save(key: string, deck: StoredDeck, written: Set<string>) {
  const savedAt = Date.now();
  const ids = new Set(deck.items.map((item) => item.id));
  await run('readwrite', (tx) => {
    const files = tx.objectStore(FILES);
    for (const item of deck.items) {
      if (written.has(item.id)) continue;
      const record: FileRecord = {
        key: fileKey(key, item.id),
        deck: key,
        savedAt,
        file: item.file,
        name: item.file.name,
        type: item.file.type,
        lastModified: item.file.lastModified,
      };
      files.put(record);
    }
    for (const id of written) if (!ids.has(id)) files.delete(fileKey(key, id));
    const record: DeckRecord = {
      key,
      savedAt,
      items: deck.items.map(({ id, kind, used }) => ({ id, kind, used })),
      photo: deck.photo,
      video: deck.video,
      seen: deck.seen,
      vetoed: deck.vetoed,
    };
    tx.objectStore(DECKS).put(record);
  });
  written.clear();
  for (const id of ids) written.add(id);
}

/** Deletes one room's stored deck. Never throws. */
export async function clearStoredDeck(key: string) {
  try {
    await run('readwrite', (tx) => {
      tx.objectStore(DECKS).delete(key);
      tx.objectStore(FILES).delete(fileRange(key));
    });
  } catch {
    // Nothing stored, or storage unavailable.
  }
}

/** Deletes decks older than six hours and any orphaned files. Call once on app start. */
export async function sweepStoredDecks() {
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    const db = await openDB();
    const records = (await request(db.transaction(DECKS, 'readonly').objectStore(DECKS).getAll())) as DeckRecord[];
    const live = new Set(records.filter((record) => record.savedAt >= cutoff).map((record) => record.key));
    await run('readwrite', (tx) => {
      for (const record of records) if (!live.has(record.key)) tx.objectStore(DECKS).delete(record.key);
      const cursor = tx.objectStore(FILES).openKeyCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const key = String(c.key);
        if (!live.has(key.slice(0, key.indexOf('|')))) tx.objectStore(FILES).delete(c.primaryKey);
        c.continue();
      };
    });
  } catch {
    // Storage unavailable: nothing to sweep.
  }
}

interface Options {
  /** Room + player key; null disables persistence. */
  key: string | null;
  /** The current deck to store. */
  snapshot: () => StoredDeck;
  /** Applies a restored deck. Called at most once, before `loaded` resolves. */
  restore: (deck: StoredDeck) => void;
}

/**
 * Restores the stored deck on mount and saves changes in the background.
 * `schedule()` after every change (debounced); `forget()` deletes the entry
 * and stops saving; `loaded` resolves once the restore attempt is over.
 */
export function useStoredDeck({ key, snapshot, restore }: Options) {
  const ctx = useRef({ snapshot, restore });
  ctx.current = { snapshot, restore };
  const enabled = useRef(Boolean(key));
  const written = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const loadedRef = useRef<{ promise: Promise<void>; done: () => void } | null>(null);
  if (!loadedRef.current) {
    let done = () => {};
    const promise = new Promise<void>((resolve) => (done = resolve));
    loadedRef.current = { promise, done };
  }

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!key || !enabled.current) return;
    const deck = ctx.current.snapshot();
    saving.current = saving.current
      .then(() => (enabled.current ? save(key, deck, written.current) : undefined))
      .catch(() => {
        // Private mode, quota, eviction: memory only from here on.
        enabled.current = false;
        void clearStoredDeck(key);
      });
  }, [key]);

  const schedule = useCallback(() => {
    if (!key || !enabled.current || timer.current !== undefined) return;
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  }, [key, flush]);

  const forget = useCallback(async () => {
    enabled.current = false;
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!key) return;
    await saving.current.catch(() => {});
    await clearStoredDeck(key);
  }, [key]);

  useEffect(() => {
    const loaded = loadedRef.current!;
    if (!key) return loaded.done();
    let cancelled = false;
    load(key)
      .then((deck) => {
        if (cancelled || !deck || !deck.items.length) return;
        for (const item of deck.items) written.current.add(item.id);
        ctx.current.restore(deck);
      })
      .catch(() => {})
      .finally(() => loaded.done());
    return () => {
      cancelled = true;
    };
  }, [key]);

  // A discarded background tab gets no unload event: save as soon as it hides.
  useEffect(() => {
    const now = () => {
      if (timer.current !== undefined) flush();
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') now();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', now);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', now);
      if (timer.current !== undefined) flush();
    };
  }, [flush]);

  return { schedule, forget, loaded: loadedRef.current.promise };
}
