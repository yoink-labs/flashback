// "Your bunch": big tiles dealt from the files the player picked: 12 photos
// and/or 6 videos (docs/MILESTONE3.md §1, §7, §8). In Mix the photo and video
// bunches are two review steps with their own swaps.
// Tap a tile = swap it (uses a swap). Hold (≥ 350 ms), right-click, the P key
// or (screen readers) the tile's own "Preview" button = preview.
// "New bunch" deals that bunch afresh and resets its swaps. Nothing leaves the
// device until a round needs one item.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { kindsFor, type BunchView, type Deck, type DeckItem, type SwapResult } from '../deck';
import { useThumb } from '../thumbs';
import type { MediaKind, MediaMode } from '../types';
import { CheckIcon, PhotoPlusIcon, PlayGlyph, PlusIcon, ShuffleIcon, XIcon } from '../ui/Icons';
import { toast } from '../ui/Toast';
import { useModal } from '../ui/useModal';

const HOLD_MS = 350;
/** A second tap this soon on the tile that just changed is a double-tap, not another swap. */
const DOUBLE_TAP_MS = 400;

const swapsLine = (left: number) => (left <= 0 ? 'No swaps left · New bunch' : `${left} ${left === 1 ? 'swap' : 'swaps'} left`);
const noun = (kind: MediaKind, count = 2) => (kind === 'photo' ? (count === 1 ? 'photo' : 'photos') : count === 1 ? 'video' : 'videos');

export function Deck({ deck, mode, step, onStep }: { deck: Deck; mode: MediaMode; step: MediaKind; onStep: (kind: MediaKind) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ item: DeckItem; slot: number } | null>(null);
  const kinds = kindsFor(mode);
  const kind = kinds.includes(step) ? step : kinds[0];
  const bunch = deck[kind];
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const pick = useCallback(() => input.current?.click(), []);

  const add = (files: File[]) => {
    if (!files.length) return;
    const wasFull = deck.photo.full && deck.video.full;
    const result = deck.addFiles(files);
    if (result.skipped) toast(`Skipped ${result.skipped}: that's the most we can hold`);
    else if (!result.added && result.duplicates) toast(result.duplicates === 1 ? 'That one is already in your pool' : 'Those are already in your pool');
    else if (result.ignored) toast(`${result.ignored} ${result.ignored === 1 ? 'file is not a photo or video' : 'files are not photos or videos'}`);
    else if (kinds.length === 2 && kind === 'photo' && result.videos && !result.photos) toast(`Added ${result.videos} ${noun('video', result.videos)} to your videos`);
    else if (kinds.length === 2 && kind === 'video' && result.photos && !result.videos) toast(`Added ${result.photos} ${noun('photo', result.photos)} to your photos`);
    else if (wasFull || bunch.full) toast(`Added ${result.added}. Swaps and new bunches draw from them`);
  };

  const lastSwap = useRef({ slot: -1, at: 0 });
  const swap = useCallback((slot: number): SwapResult | 'ignored' => {
    const now = performance.now();
    if (lastSwap.current.slot === slot && now - lastSwap.current.at < DOUBLE_TAP_MS) return 'ignored';
    const result = deckRef.current.swap(kindRef.current, slot);
    if (result === 'swapped') lastSwap.current = { slot, at: now };
    if (result === 'no-pool') toast(`Pick more ${noun(kindRef.current)} to swap`);
    return result;
  }, []);

  const openPreview = useCallback((item: DeckItem, slot: number) => setPreview({ item, slot }), []);

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    add([...event.dataTransfer.files]);
  };

  const empty = bunch.items.length === 0;
  const placeholders = empty ? 0 : Math.max(0, bunch.size - bunch.items.length);
  const short = !empty && !bunch.full;
  const pickLabel = kind === 'photo' ? 'Pick photos' : 'Pick videos';
  const otherMode = kind === 'photo' ? 'Videos' : 'Photos';
  const noVideos = kind === 'video' && !deck.canSendVideos;

  return (
    <section
      className={`bunch${dragging ? ' dragging' : ''}${empty ? ' is-empty' : ''} bunch-${kind}`}
      aria-label={kind === 'photo' ? 'Your photo bunch' : 'Your video bunch'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <input
        ref={input}
        type="file"
        accept={kind === 'photo' ? 'image/*' : 'video/*'}
        multiple
        hidden
        data-testid="media-input"
        onChange={(event) => {
          add([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />

      <div className="bunch-frame">
        {kinds.length === 2 && <Steps deck={deck} kind={kind} onStep={onStep} />}

        {noVideos && (
          <p className="bunch-notice" role="alert" data-testid="no-video-support">
            This browser can’t send videos. Open Flashback in the latest Chrome or Safari{mode === 'both' ? ', or ask the host to switch to Photos' : ''}.
          </p>
        )}

        {empty ? (
          <div className="bunch-empty" onClick={pick}>
            <span className="bunch-empty-icon">
              <PhotoPlusIcon />
            </span>
            <button type="button" className="btn primary bunch-pick" onClick={(event) => (event.stopPropagation(), pick())} data-testid="pick-media">
              {pickLabel}
            </button>
            <p className="caption">{kind === 'photo' ? 'Select 20 or more. We deal you 12.' : 'Select 10 or more. We deal you 6.'}</p>
            <p className="caption bunch-privacy">Only the {kind === 'photo' ? 'photo' : 'video'} picked each round is sent.</p>
          </div>
        ) : (
          <>
            <div className="bunch-head">
              <h2 className="headline">{kinds.length === 2 ? (kind === 'photo' ? 'Your photos' : 'Your videos') : 'Your bunch'}</h2>
              <span className={`bunch-swaps${bunch.swapsLeft <= 0 ? ' out' : ''}`} aria-live="polite" data-testid="swaps-left">
                {swapsLine(bunch.swapsLeft)}
              </span>
            </div>

            <ul className={`bunch-grid n${bunch.size}`} data-testid="bunch-grid">
              {bunch.items.map((item, slot) => (
                // Keyed by slot so focus stays on the tile after a swap; the face re-keys per item.
                <li key={slot} className="bunch-slot">
                  <Tile item={item} slot={slot} onSwap={swap} onPreview={openPreview} />
                </li>
              ))}
              {Array.from({ length: placeholders }, (_, index) => (
                <li key={`add-${index}`} className="bunch-slot">
                  <button type="button" className="tile tile-add" onClick={pick} aria-label={pickLabel}>
                    <PlusIcon size={24} />
                  </button>
                </li>
              ))}
            </ul>

            {short && (
              <p className="caption bunch-short" role="status">
                You have {bunch.items.length} of {bunch.size} {noun(kind)}. Pick more{mode === 'both' ? ` or ask the host to switch to ${otherMode}` : ''}.
              </p>
            )}

            <div className="bunch-actions">
              <button type="button" className="btn secondary small" onClick={() => deck.newBunch(kind)} disabled={!bunch.canSwap} data-testid="new-bunch">
                <ShuffleIcon size={18} />
                New bunch
              </button>
              <button type="button" className="btn secondary small" onClick={pick} data-testid="add-media">
                <PlusIcon size={18} />
                {kind === 'photo' ? 'Add photos' : 'Add videos'}
              </button>
            </div>
          </>
        )}
      </div>

      {preview && (
        <Lightbox
          item={preview.item}
          swapsLeft={bunch.swapsLeft}
          canSwap={bunch.canSwap}
          onSwap={() => {
            const result = swap(preview.slot);
            if (result === 'swapped') setPreview(null);
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

/** Mix: "Photos 12/12 ✓" · "Videos 0/6". Either can be opened any time. */
function Steps({ deck, kind, onStep }: { deck: Deck; kind: MediaKind; onStep: (kind: MediaKind) => void }) {
  const step = (view: BunchView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={kind === view.kind}
      className={`step${kind === view.kind ? ' on' : ''}${view.full ? ' done' : ''}`}
      onClick={() => onStep(view.kind)}
      data-testid={`step-${view.kind}`}
    >
      <span>{label}</span>
      <span className="step-count">
        {view.items.length}/{view.size}
      </span>
      {view.full && (
        <span className="step-check" aria-label="done">
          <CheckIcon size={14} />
        </span>
      )}
    </button>
  );
  return (
    <div className="steps" role="tablist" aria-label="Review steps">
      {step(deck.photo, 'Photos')}
      {step(deck.video, 'Videos')}
    </div>
  );
}

const Tile = memo(function Tile({
  item,
  slot,
  onSwap,
  onPreview,
}: {
  item: DeckItem;
  slot: number;
  onSwap: (slot: number) => SwapResult | 'ignored';
  onPreview: (item: DeckItem, slot: number) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };

  useEffect(() => cancel, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    held.current = false;
    start.current = { x: event.clientX, y: event.clientY };
    timer.current = setTimeout(() => {
      held.current = true;
      timer.current = null;
      navigator.vibrate?.(8);
      onPreview(item, slot);
    }, HOLD_MS);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const origin = start.current;
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancel();
  };

  const shake = (element: HTMLElement) =>
    element.animate?.(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }],
      { duration: 320, easing: 'ease-out' },
    );

  const activate = (element: HTMLElement) => {
    const result = onSwap(slot);
    if (result === 'no-swaps' || result === 'no-pool') shake(element);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // Keyboard: Enter/Space swap (the click), P or the context-menu key previews.
    if (event.key === 'p' || event.key === 'P' || event.key === 'ContextMenu') {
      event.preventDefault();
      onPreview(item, slot);
    }
  };

  const name = `${item.kind === 'video' ? 'Video' : 'Photo'} ${slot + 1}`;

  return (
    <>
    <button
      type="button"
      className="tile"
      aria-label={`${name}. Tap to swap, hold to preview`}
      aria-keyshortcuts="P"
      data-testid="bunch-tile"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onContextMenu={(event) => {
        event.preventDefault();
        cancel();
        if (!held.current) onPreview(item, slot);
        held.current = true;
      }}
      onClick={(event) => {
        if (held.current) {
          held.current = false;
          return;
        }
        activate(event.currentTarget);
      }}
      onKeyDown={onKeyDown}
    >
      <TileFace key={item.id} item={item} />
    </button>
    {/* Holding is not available to everyone: screen readers reach this instead. */}
    <button type="button" className="sr-only" tabIndex={-1} onClick={() => onPreview(item, slot)}>
      Preview {name}
    </button>
    </>
  );
});

/** The picture inside a tile. Re-mounted per item, so a swap animates in and waits for its own image. */
function TileFace({ item }: { item: DeckItem }) {
  const thumb = useThumb(item.id, item.file, item.kind);
  const [loaded, setLoaded] = useState(false);
  return (
    <span className="tile-face">
      {thumb?.url ? (
        <img
          className={`tile-img${loaded ? ' loaded' : ''}`}
          src={thumb.url}
          alt=""
          draggable={false}
          decoding="async"
          onLoad={() => setLoaded(true)}
        />
      ) : thumb?.failed ? (
        <span className="tile-fallback caption">{item.kind === 'video' ? 'Video' : 'Photo'}</span>
      ) : null}
      {item.kind === 'video' && (
        <span className="tile-time">
          <PlayGlyph />
          {formatDuration(thumb?.seconds)}
        </span>
      )}
    </span>
  );
}

function Lightbox({
  item,
  swapsLeft,
  canSwap,
  onSwap,
  onClose,
}: {
  item: DeckItem;
  swapsLeft: number;
  canSwap: boolean;
  onSwap: () => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  const openedAt = useRef(performance.now());
  useModal(onClose);

  useEffect(() => {
    const objectURL = URL.createObjectURL(item.file);
    setUrl(objectURL);
    setBroken(false);
    return () => URL.revokeObjectURL(objectURL);
  }, [item.file]);

  // The finger that opened it by holding lifts over the backdrop: ignore that.
  const closeFromBackdrop = () => {
    if (performance.now() - openedAt.current > 450) onClose();
  };

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Preview" onClick={closeFromBackdrop} data-testid="lightbox">
      <div className="lightbox-media">
        {broken ? (
          <p className="caption">This browser can’t show this one</p>
        ) : (
          url &&
          (item.kind === 'photo' ? (
            <img src={url} alt="A photo in your bunch" decoding="async" onClick={closeFromBackdrop} onError={() => setBroken(true)} />
          ) : (
            <video src={url} autoPlay loop muted playsInline onClick={(event) => event.stopPropagation()} onError={() => setBroken(true)} />
          ))
        )}
      </div>
      <div className="lightbox-bar" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="btn secondary small" onClick={onSwap} disabled={swapsLeft <= 0 || !canSwap}>
          <ShuffleIcon size={18} />
          Swap this one
        </button>
        <span className="caption">{canSwap ? swapsLine(swapsLeft) : `Pick more ${noun(item.kind)} to swap`}</span>
      </div>
      <button type="button" className="round-btn lightbox-close" onClick={onClose} autoFocus aria-label="Close preview">
        <XIcon />
      </button>
    </div>
  );
}

/** Video length as m:ss, like the badge on the tile. */
function formatDuration(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
