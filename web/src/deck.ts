// The player's local deck and the prepared-next item.
//
// The deck is a list of files that never leave the device. Only one item per
// round is compressed and uploaded, and only when the server privately asks for
// it (`turn`). From the moment the player readies up we keep one item already
// processed so that upload starts instantly. All of this is silent: nothing in
// the UI may hint that it is this player's turn.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { uploadMedia, type RoomSession } from './api';
import { isVideoFile, preparePhoto, prepareVideo } from './media';
import type { ClientMessage, DeckCounts, MediaKind, MediaMode, Phase, TurnMessage } from './types';

export interface DeckItem {
  id: string;
  file: File;
  kind: MediaKind;
  hidden: boolean;
  /** Already shown (or on its way) this session. Never picked again until recycled. */
  used: boolean;
}

export const MAX_DECK = 200;
export const TRIM_TO = 24;

export const fitsMode = (kind: MediaKind, mode: MediaMode) =>
  mode === 'both' || (mode === 'photos' ? kind === 'photo' : kind === 'video');

let sequence = 0;
const newID = () => `d${Date.now().toString(36)}${(sequence++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

interface Prepared {
  itemID: string;
  kind: MediaKind;
  blob: Blob;
}

interface Args {
  send: (message: ClientMessage) => void;
  /** Always call with the newest session token. */
  session: () => RoomSession;
  mode: MediaMode;
  phase: Phase;
  ready: boolean;
  connected: boolean;
  game: number;
  /** Receives the owner's own copy so it can be shown without a round trip. */
  onUploaded: (game: number, round: number, blob: Blob, kind: MediaKind) => void;
}

export function useDeck(args: Args) {
  const [items, setItems] = useState<DeckItem[]>([]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const itemsRef = useRef<DeckItem[]>(items);
  const preparedRef = useRef<Prepared | null>(null);
  /** The preparation currently running, so a turn can wait for it instead of passing. */
  const preparingRef = useRef<Promise<void> | null>(null);
  const failedRef = useRef<Set<string>>(new Set());
  const lastDeck = useRef('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const ctx = useRef(args);
  ctx.current = args;

  const update = useCallback((change: (previous: DeckItem[]) => DeckItem[]) => {
    itemsRef.current = change(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  const setDuration = useCallback((id: string, seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setDurations((previous) => (previous[id] === seconds ? previous : { ...previous, [id]: seconds }));
  }, []);

  /** An item still eligible to be prepared and uploaded. */
  const usable = useCallback((id: string, mode: MediaMode) => {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    return Boolean(item && !item.hidden && !item.used && fitsMode(item.kind, mode));
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const media = files.filter((file) => file.type.startsWith('image/') || isVideoFile(file));
      const room = Math.max(0, MAX_DECK - itemsRef.current.length);
      const accepted = media.slice(0, room);
      if (accepted.length) {
        const added: DeckItem[] = accepted.map((file) => ({
          id: newID(),
          file,
          kind: isVideoFile(file) ? 'video' : 'photo',
          hidden: false,
          used: false,
        }));
        update((previous) => [...previous, ...added]);
      }
      return { added: accepted.length, skipped: media.length - accepted.length, ignored: files.length - media.length };
    },
    [update],
  );

  const setHidden = useCallback(
    (id: string, hidden: boolean) => update((previous) => previous.map((item) => (item.id === id ? { ...item, hidden } : item))),
    [update],
  );

  const removeItem = useCallback(
    (id: string) => update((previous) => previous.filter((item) => item.id !== id)),
    [update],
  );

  /** Keeps a random 24 of the current items and drops the rest from the deck. */
  const pickRandom = useCallback(() => {
    const all = itemsRef.current;
    if (all.length <= TRIM_TO) return 0;
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const keep = new Set(shuffled.slice(0, TRIM_TO).map((item) => item.id));
    update((previous) => previous.filter((item) => keep.has(item.id)));
    return all.length - TRIM_TO;
  }, [update]);

  /**
   * One unused, unhidden item that fits the mode; when every item has been
   * shown, the used marks are cleared so the deck recycles.
   */
  const pickCandidate = useCallback(
    (mode: MediaMode): DeckItem | null => {
      const pool = itemsRef.current.filter((item) => !item.hidden && !item.used && fitsMode(item.kind, mode) && !failedRef.current.has(item.id));
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
      const recyclable = itemsRef.current.filter((item) => item.used && !item.hidden && fitsMode(item.kind, mode) && !failedRef.current.has(item.id));
      if (!recyclable.length) return null;
      update((previous) => previous.map((item) => (item.used && !item.hidden && fitsMode(item.kind, mode) ? { ...item, used: false } : item)));
      return recyclable[Math.floor(Math.random() * recyclable.length)];
    },
    [update],
  );

  /** Processes one item in the background and keeps it ready to upload. */
  const prepareNext = useCallback(
    (mode: MediaMode) => {
      if (preparingRef.current) return preparingRef.current;
      const run = (async () => {
        for (let attempt = 0; attempt < Math.min(30, itemsRef.current.length + 1); attempt++) {
          const prepared = preparedRef.current;
          if (prepared && usable(prepared.itemID, mode)) return;
          preparedRef.current = null;
          const item = pickCandidate(mode);
          if (!item) return;
          try {
            const blob = item.kind === 'photo' ? await preparePhoto(item.file) : await prepareVideo(item.file);
            if (usable(item.id, mode)) {
              preparedRef.current = { itemID: item.id, kind: item.kind, blob };
              return;
            }
          } catch {
            // Try the next item; one unreadable file must not stall the round.
            failedRef.current.add(item.id);
          }
        }
      })();
      preparingRef.current = run;
      void run.finally(() => {
        if (preparingRef.current === run) preparingRef.current = null;
      });
      return run;
    },
    [pickCandidate, usable],
  );

  const handleTurn = useCallback(
    async (turn: TurnMessage) => {
      const mode = turn.mode ?? ctx.current.mode;
      let prepared = preparedRef.current;
      if (prepared && !usable(prepared.itemID, mode)) preparedRef.current = null;
      prepared = preparedRef.current;
      // Wait for any preparation already running (it may be for a different
      // mode, in which case the loop asks again for this one).
      for (let attempt = 0; !prepared && attempt < 2; attempt++) {
        await prepareNext(mode);
        prepared = preparedRef.current;
        if (prepared && !usable(prepared.itemID, mode)) preparedRef.current = null;
        prepared = preparedRef.current;
      }
      if (!prepared) {
        ctx.current.send({ type: 'pass', slot: turn.slot });
        return;
      }
      const contentType = prepared.kind === 'photo' ? 'image/jpeg' : 'video/mp4';
      try {
        await uploadMedia(ctx.current.session(), turn.slot, prepared.blob, contentType);
        const uploaded = prepared;
        preparedRef.current = null;
        update((previous) => previous.map((item) => (item.id === uploaded.itemID ? { ...item, used: true } : item)));
        ctx.current.onUploaded(turn.game, turn.round, uploaded.blob, uploaded.kind);
        void prepareNext(mode);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 0;
        // 409/404: the turn already moved on (timeout or reassign). Keep the
        // prepared item for next time and say nothing.
        if (status === 409 || status === 404) return;
        if (status !== 0) {
          // The server rejected this file: never offer it again.
          const rejected = prepared;
          preparedRef.current = null;
          update((previous) => previous.map((item) => (item.id === rejected.itemID ? { ...item, used: true } : item)));
        }
        ctx.current.send({ type: 'pass', slot: turn.slot });
        void prepareNext(mode);
      }
    },
    [prepareNext, update, usable],
  );

  /** Turns are handled one at a time so two lookahead slots cannot race. */
  const enqueueTurn = useCallback(
    (turn: TurnMessage) => {
      queue.current = queue.current.then(() => handleTurn(turn)).catch(() => {});
    },
    [handleTurn],
  );

  // Keep one item processed from ready-up onward (and through the game).
  useEffect(() => {
    const active = args.phase === 'countdown' || args.phase === 'reveal' || args.phase === 'results' || (args.phase === 'lobby' && args.ready);
    if (!active) return;
    const prepared = preparedRef.current;
    if (prepared && usable(prepared.itemID, args.mode)) return;
    preparedRef.current = null;
    void prepareNext(args.mode);
  }, [args.mode, args.phase, args.ready, items, prepareNext, usable]);

  const counts = useMemo<DeckCounts>(() => {
    let photos = 0;
    let videos = 0;
    for (const item of items) {
      if (item.hidden || item.used || !fitsMode(item.kind, args.mode)) continue;
      if (item.kind === 'photo') photos += 1;
      else videos += 1;
    }
    return { photos, videos };
  }, [items, args.mode]);

  // Tell the server the deck size whenever it changes (or after a reconnect).
  const { connected, send } = args;
  useEffect(() => {
    if (!connected) {
      lastDeck.current = '';
      return;
    }
    const payload = `${counts.photos}:${counts.videos}`;
    if (lastDeck.current === payload) return;
    lastDeck.current = payload;
    send({ type: 'deck', photos: counts.photos, videos: counts.videos });
  }, [connected, send, counts]);

  return {
    items,
    durations,
    counts,
    available: counts.photos + counts.videos,
    addFiles,
    setHidden,
    removeItem,
    pickRandom,
    setDuration,
    handleTurn: enqueueTurn,
  };
}

export type Deck = ReturnType<typeof useDeck>;
