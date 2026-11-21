// "Your deck": the local files the server may ask for one at a time. The grid
// is the point — tap to hide, hover the ⋯ (or long-press on touch) to preview.
// Nothing leaves the device until a round needs one.
import { useEffect, useRef, useState } from 'react';
import type { DragEvent, PointerEvent } from 'react';
import { fitsMode, MAX_DECK, TRIM_TO, type Deck, type DeckItem } from '../deck';
import type { MediaMode } from '../types';
import { MoreIcon, XIcon } from '../ui/Icons';

export function Deck({ deck, mode }: { deck: Deck; mode: MediaMode }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<DeckItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const add = (files: File[]) => {
    if (!files.length) return;
    const result = deck.addFiles(files);
    if (result.skipped || result.ignored) {
      const parts: string[] = [];
      if (result.skipped) parts.push(`Skipped ${result.skipped} · ${MAX_DECK} max`);
      if (result.ignored) parts.push(`${result.ignored} not a photo or video`);
      setNotice(parts.join(' · '));
    }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    add([...event.dataTransfer.files]);
  };

  const unhidden = deck.items.filter((item) => !item.hidden).length;
  const trim = () => {
    const removed = deck.pickRandom();
    if (removed) setNotice(`Kept ${TRIM_TO} at random`);
  };

  return (
    <section
      className={`deck${dragging ? ' dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <div className="deck-head">
        <h2 className="headline">
          Your deck
          {deck.items.length > 0 && <span className="deck-count"> · {unhidden} of {deck.items.length}</span>}
        </h2>
      </div>

      <input
        ref={input}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        data-testid="media-input"
        onChange={(event) => {
          add([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />

      {deck.items.length === 0 ? (
        <>
          <button type="button" className="deck-empty" onClick={() => input.current?.click()}>
            <PhotoPlusIcon />
            <span className="deck-empty-title">Add photos &amp; videos</span>
          </button>
          <p className="caption deck-privacy">Only the photo picked each round is sent.</p>
        </>
      ) : (
        <ul className="deck-grid">
          {deck.items.map((item) => (
            <DeckTile
              key={item.id}
              item={item}
              mode={mode}
              seconds={deck.durations[item.id]}
              onDuration={(seconds) => deck.setDuration(item.id, seconds)}
              onHide={() => deck.setHidden(item.id, !item.hidden)}
              onPreview={() => setPreview(item)}
            />
          ))}
        </ul>
      )}

      <div className="deck-actions">
        <button type="button" className="btn secondary compact" onClick={trim} disabled={deck.items.length <= TRIM_TO}>
          Shuffle
        </button>
        <button type="button" className="btn secondary compact" onClick={() => input.current?.click()}>
          {deck.items.length ? 'Add…' : 'Add'}
        </button>
      </div>

      {notice && (
        <p className="caption" role="status">
          {notice}
        </p>
      )}

      {preview && <Preview item={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

function DeckTile({
  item,
  mode,
  seconds,
  onDuration,
  onHide,
  onPreview,
}: {
  item: DeckItem;
  mode: MediaMode;
  seconds?: number;
  onDuration: (seconds: number) => void;
  onHide: () => void;
  onPreview: () => void;
}) {
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  const stopPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };

  const startPress = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    longPressed.current = false;
    press.current = setTimeout(() => {
      longPressed.current = true;
      onPreview();
    }, 450);
  };

  const fits = fitsMode(item.kind, mode);
  return (
    <li className={`deck-tile${item.hidden ? ' hidden' : ''}${item.used ? ' used' : ''}${fits ? '' : ' off-mode'}`}>
      <button
        type="button"
        className="tile-press"
        aria-pressed={item.hidden}
        aria-label={`${item.kind === 'video' ? 'Video' : 'Photo'}${item.hidden ? ', hidden. Tap to show' : '. Tap to hide'}`}
        onClick={() => {
          if (longPressed.current) {
            longPressed.current = false;
            return;
          }
          onHide();
        }}
        onPointerDown={startPress}
        onPointerUp={stopPress}
        onPointerCancel={stopPress}
        onPointerLeave={stopPress}
      >
        {item.kind === 'photo' ? <PhotoThumb file={item.file} /> : <VideoThumb file={item.file} onDuration={onDuration} />}
        {item.kind === 'video' && (
          <span className="tile-time">
            <PlayGlyph />
            {formatDuration(seconds)}
          </span>
        )}
        {item.hidden && (
          <span className="tile-hidden" aria-hidden="true">
            <EyeOffIcon />
          </span>
        )}
      </button>
      <button
        type="button"
        className="tile-more"
        aria-label="Preview"
        onClick={onPreview}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MoreIcon />
      </button>
    </li>
  );
}

function useObjectURL(file: File) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectURL = URL.createObjectURL(file);
    setUrl(objectURL);
    return () => URL.revokeObjectURL(objectURL);
  }, [file]);
  return url;
}

function PhotoThumb({ file }: { file: File }) {
  const url = useObjectURL(file);
  return url ? <img className="thumb" src={url} alt="" loading="lazy" draggable={false} /> : <span className="thumb thumb-skeleton" />;
}

function VideoThumb({ file, onDuration }: { file: File; onDuration: (seconds: number) => void }) {
  const host = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);

  // Only load a video when its tile nears the viewport: a deck of 100 clips
  // must not decode 100 videos at once.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setUrl(URL.createObjectURL(file));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setUrl(URL.createObjectURL(file));
        observer.disconnect();
      },
      { rootMargin: '240px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [file]);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return (
    <span className="thumb" ref={host}>
      {url ? (
        <video
          src={url}
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            onDuration(video.duration);
            try {
              video.currentTime = Math.min(0.12, (video.duration || 1) / 3);
            } catch {}
          }}
        />
      ) : (
        <span className="thumb-skeleton" />
      )}
    </span>
  );
}

function Preview({ item, onClose }: { item: DeckItem; onClose: () => void }) {
  const url = useObjectURL(item.file);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="Preview" onClick={onClose}>
      <div className="preview-body" onClick={(event) => event.stopPropagation()}>
        {item.kind === 'photo' ? (
          url && <img src={url} alt="A photo in your deck" />
        ) : (
          url && <video src={url} controls autoPlay playsInline muted />
        )}
      </div>
      <button type="button" className="preview-close" onClick={onClose} autoFocus aria-label="Close preview">
        <XIcon />
      </button>
    </div>
  );
}

/** Video length as m:ss, like the badge on the tile. */
function formatDuration(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return '0:00';
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 8 10" width="8" height="10" fill="currentColor" aria-hidden="true">
      <path d="M0 0l8 5-8 5z" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function PhotoPlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="14" height="14" rx="2.5" />
      <path d="M3 15l4-4 4 4 2-2 4 4" />
      <path d="M19 2v6M16 5h6" />
    </svg>
  );
}
