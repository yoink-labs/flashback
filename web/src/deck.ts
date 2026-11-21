// The player's deck as a React hook: the current DeckModel (deckModel.ts holds
// every rule about what is in a bunch) plus the async work around it.
//
// Nothing leaves the device until the server privately asks for one item
// (`turn`, which names the kind). Only bunch items are candidates. From the
// moment the player readies up we keep one item of each needed kind already
// processed so that upload starts instantly. All of this is silent: nothing in
// the UI may hint that it is this player's turn.
//
// The bunches (not the whole pool) survive a tab reload via deckStore.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIError, uploadMedia, type RoomSession } from './api';
import * as model from './deckModel';
import { useStoredDeck } from './deckStore';
import { canConvertVideos, mediaKindOf, preparePhoto, prepareVideo } from './media';
import { loadThumb } from './thumbs';
import type { ClientMessage, MediaKind, MediaMode, Phase, TurnMessage } from './types';
import { toast } from './ui/Toast';

export { kindsFor, type BunchView, type DeckItem, type SwapResult } from './deckModel';

let sequence = 0;
const newID = () => `d${Date.now().toString(36)}${(sequence++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

interface Prepared {
  itemID: string;
  blob: Blob;
}

interface Args {
  send: (message: ClientMessage) => void;
  /** Always call with the newest session token. */
  session: () => RoomSession;
  mode: MediaMode;
  /** `settings.swaps`: swaps per bunch. */
  swaps: number;
  phase: Phase;
  ready: boolean;
  connected: boolean;
  /** IndexedDB key for this room + player (`deckKey`); null keeps the deck in memory only. */
  storeKey: string | null;
  /** Receives the owner's own copy so it can be shown without a round trip. */
  onUploaded: (game: number, round: number, blob: Blob, kind: MediaKind) => void;
}

const inGame = (phase: Phase) => phase === 'countdown' || phase === 'reveal' || phase === 'results';

export function useDeck(args: Args) {
  const modelRef = useRef<model.DeckModel>(model.EMPTY_DECK);
  const [state, setState] = useState<model.DeckModel>(model.EMPTY_DECK);
  const preparedRef = useRef<Record<MediaKind, Prepared | null>>({ photo: null, video: null });
  /** Preparations running, so a turn can wait for one instead of passing. */
  const preparingRef = useRef<Record<MediaKind, Promise<void> | null>>({ photo: null, video: null });
  const lastDeck = useRef('');
  const queue = useRef<Promise<void>>(Promise.resolve());
  const ctx = useRef(args);
  ctx.current = args;
  const [loaded, setLoaded] = useState(false);

  const [canSendVideos, setCanSendVideos] = useState(() => typeof VideoEncoder !== 'undefined');
  const videosOK = useRef(canSendVideos);
  videosOK.current = canSendVideos;

  /**
   * The one way the model changes. The ref updates synchronously, so
   * back-to-back taps (and async work) always build on the latest model.
   */
  const commit = useCallback((next: model.DeckModel) => {
    if (next === modelRef.current) return;
    modelRef.current = next;
    setState(next);
  }, []);

  const stored = useStoredDeck({
    key: args.storeKey,
    snapshot: () => model.snapshot(modelRef.current),
    restore: (deck) => {
      // Files picked while the restore was loading win.
      if (!modelRef.current.pool.length) commit(model.restore(deck));
    },
  });
  const { schedule: scheduleSave, loaded: storeLoaded } = stored;
  useEffect(() => {
    let live = true;
    void storeLoaded.then(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [storeLoaded]);
  // Save after every change, once the restore attempt can no longer be overwritten.
  useEffect(() => {
    if (loaded) scheduleSave();
  }, [loaded, state, scheduleSave]);

  useEffect(() => {
    let live = true;
    void canConvertVideos().then((ok) => live && setCanSendVideos(ok));
    return () => {
      live = false;
    };
  }, []);

  /** Never offer this item again; its tile is refilled for free when the pool allows. */
  const fail = useCallback(
    (id: string) => {
      if (modelRef.current.failed.has(id)) return;
      if (preparedRef.current.photo?.itemID === id) preparedRef.current.photo = null;
      if (preparedRef.current.video?.itemID === id) preparedRef.current.video = null;
      commit(model.markFailed(modelRef.current, id));
    },
    [commit],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      const [next, summary] = model.addFiles(modelRef.current, files, mediaKindOf, newID);
      commit(next);
      return summary;
    },
    [commit],
  );

  const swap = useCallback(
    (kind: MediaKind, slot: number) => {
      const [next, result] = model.swap(modelRef.current, kind, slot, ctx.current.swaps);
      commit(next);
      return result;
    },
    [commit],
  );

  const newBunch = useCallback((kind: MediaKind) => commit(model.newBunch(modelRef.current, kind)), [commit]);

  // Thumbnails double as a cheap readability check: a bunch item this browser
  // can't open at all (HEIC in Chrome, a codec it lacks) is replaced right away
  // instead of failing at turn time. Only the kinds the mode plays are checked.
  const bunchIDs = model.kindsFor(args.mode).flatMap((kind) => state[kind].ids).join(',');
  useEffect(() => {
    let live = true;
    const current = modelRef.current;
    for (const item of model.kindsFor(ctx.current.mode).flatMap((kind) => model.bunchItems(current, kind))) {
      void loadThumb(item.id, item.file, item.kind).then((thumb) => {
        if (!live || !thumb.failed) return;
        // Silent in a game: a toast then could hint that it is this player's turn.
        if (ctx.current.phase === 'lobby') toast(`Can’t open “${item.file.name}” in this browser`);
        fail(item.id);
      });
    }
    return () => {
      live = false;
    };
  }, [bunchIDs, fail]);

  /** Processes one item of `kind` in the background and keeps it ready to upload. */
  const prepareNext = useCallback(
    (kind: MediaKind) => {
      const running = preparingRef.current[kind];
      if (running) return running;
      // Without WebCodecs every clip would fail: don't mark them all unreadable.
      if (kind === 'video' && !videosOK.current) return Promise.resolve();
      const run = (async () => {
        for (let attempt = 0; attempt < model.BUNCH_SIZE[kind] + 2; attempt++) {
          const prepared = preparedRef.current[kind];
          if (prepared && model.isUsable(modelRef.current, prepared.itemID, kind)) return;
          preparedRef.current[kind] = null;
          const [next, candidate] = model.pickCandidate(modelRef.current, kind);
          commit(next);
          if (!candidate) return;
          try {
            const blob = kind === 'photo' ? await preparePhoto(candidate.file) : await prepareVideo(candidate.file);
            if (model.isUsable(modelRef.current, candidate.id, kind)) {
              preparedRef.current[kind] = { itemID: candidate.id, blob };
              return;
            }
          } catch {
            // Try the next item; one unreadable file must not stall the round.
            fail(candidate.id);
          }
        }
      })();
      preparingRef.current[kind] = run;
      void run.finally(() => {
        if (preparingRef.current[kind] === run) preparingRef.current[kind] = null;
      });
      return run;
    },
    [commit, fail],
  );

  /** The kind to upload for a turn: the one the server names, else a random one the mode allows. */
  const kindForTurn = useCallback((turn: TurnMessage): MediaKind | null => {
    if (turn.kind === 'photo' || turn.kind === 'video') return turn.kind;
    const kinds = model.kindsFor(turn.mode ?? ctx.current.mode);
    const ready = kinds.filter((kind) => preparedRef.current[kind]);
    const options = ready.length ? ready : kinds.filter((kind) => modelRef.current[kind].ids.length);
    return options.length ? options[Math.floor(Math.random() * options.length)] : null;
  }, []);

  const handleTurn = useCallback(
    async (turn: TurnMessage) => {
      const pass = () => ctx.current.send({ type: 'pass', slot: turn.slot });
      const kind = kindForTurn(turn);
      if (!kind) return pass();
      const current = () => {
        const prepared = preparedRef.current[kind];
        if (prepared && !model.isUsable(modelRef.current, prepared.itemID, kind)) preparedRef.current[kind] = null;
        return preparedRef.current[kind];
      };
      let prepared = current();
      // Wait for a preparation already running, or start one.
      for (let attempt = 0; !prepared && attempt < 2; attempt++) {
        await prepareNext(kind);
        prepared = current();
      }
      if (!prepared) return pass();
      try {
        await uploadMedia(ctx.current.session(), turn.slot, prepared.blob, kind === 'photo' ? 'image/jpeg' : 'video/mp4');
        preparedRef.current[kind] = null;
        commit(model.setUsed(modelRef.current, new Set([prepared.itemID]), true));
        ctx.current.onUploaded(turn.game, turn.round, prepared.blob, kind);
        void prepareNext(kind);
      } catch (error) {
        const status = error instanceof APIError ? error.status : 0;
        // 409/404: the turn already moved on (timeout or reassign). Keep the
        // prepared item for next time and say nothing.
        if (status === 409 || status === 404) return;
        // Any other answer from the server rejected this file: never offer it again.
        if (status !== 0) fail(prepared.itemID);
        pass();
        void prepareNext(kind);
      }
    },
    [commit, fail, kindForTurn, prepareNext],
  );

  /** Turns are handled one at a time so two lookahead slots cannot race. */
  const enqueueTurn = useCallback(
    (turn: TurnMessage) => {
      // After a reload, wait for the stored bunch before answering a turn.
      queue.current = queue.current
        .then(() => storeLoaded)
        .then(() => handleTurn(turn))
        .catch(() => {});
    },
    [handleTurn, storeLoaded],
  );

  // Keep one item of each needed kind processed from ready-up onward (and
  // through the game). Photos first: they are quick; videos are re-encoded.
  const active = inGame(args.phase) || (args.phase === 'lobby' && args.ready);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      for (const kind of model.kindsFor(args.mode)) {
        if (cancelled) return;
        await prepareNext(kind);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, args.mode, canSendVideos, state, prepareNext]);

  const photo = useMemo(() => model.bunchView(state, 'photo', args.swaps), [state, args.swaps]);
  const video = useMemo(() => model.bunchView(state, 'video', args.swaps), [state, args.swaps]);
  const counts = useMemo(() => model.deckCounts(state, args.mode, canSendVideos), [state, args.mode, canSendVideos]);

  // Tell the server the deck size whenever it changes (or after a reconnect).
  const { connected, send } = args;
  useEffect(() => {
    if (!connected) {
      lastDeck.current = '';
      return;
    }
    // Don't report an empty deck (and lose Ready) while the stored bunch loads.
    if (!loaded) return;
    const payload = `${counts.photos}:${counts.videos}`;
    if (lastDeck.current === payload) return;
    lastDeck.current = payload;
    send({ type: 'deck', photos: counts.photos, videos: counts.videos });
  }, [connected, send, counts, loaded]);

  return {
    photo,
    video,
    counts,
    /** The bunches meet the mode's need, exactly as the server checks it. */
    fits: model.deckFits(counts, args.mode),
    /** False when this browser can't convert clips (no WebCodecs H.264). */
    canSendVideos,
    addFiles,
    swap,
    newBunch,
    handleTurn: enqueueTurn,
    /** Deletes the stored bunch (leaving, room closed, removed). */
    forget: stored.forget,
  };
}

export type Deck = ReturnType<typeof useDeck>;
