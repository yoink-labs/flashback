// docs/MILESTONE4.md §8: one <video> per device, at most one clip playing.
//
// The element is a singleton owned by this module and re-parented into
// whichever surface needs it (deck tile hover, the hold/lightbox preview, the
// reveal, the results thumbnail). Moving a media element in the DOM keeps its
// playback state; switching `src` starts the new clip.
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';

const FINE_POINTER = '(hover: hover) and (pointer: fine)';

/** Whether this device should hover-play deck tiles (fine pointer, real hover). */
export const canHoverPlay = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(FINE_POINTER).matches);

export interface HubOptions {
  playing: boolean;
  muted: boolean;
  loop: boolean;
  className: string;
}

class PlaybackHub {
  private element: HTMLVideoElement | null = null;
  private owner: symbol | null = null;

  /** The one video element (created on first use). */
  video(): HTMLVideoElement {
    if (!this.element) {
      const video = document.createElement('video');
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.preload = 'auto';
      video.muted = true;
      this.element = video;
    }
    return this.element;
  }

  /** Takes the player for `owner`, points it at `src` and applies `options`. */
  claim(owner: symbol, src: string, options: HubOptions): HTMLVideoElement {
    const video = this.video();
    this.owner = owner;
    video.className = options.className;
    if (video.getAttribute('src') !== src) {
      video.setAttribute('src', src);
      try {
        video.currentTime = 0;
      } catch {}
    }
    // Muted must be set before play so autoplay is allowed.
    video.muted = options.muted;
    video.loop = options.loop;
    if (options.playing) void video.play().catch(() => {});
    else video.pause();
    return video;
  }

  /** Updates the current owner's options without touching the source. */
  configure(owner: symbol, options: HubOptions) {
    if (this.owner !== owner || !this.element) return;
    const video = this.element;
    video.className = options.className;
    video.muted = options.muted;
    video.loop = options.loop;
    if (options.playing) void video.play().catch(() => {});
    else video.pause();
  }

  /** Gives the player up (only if this owner still holds it). */
  release(owner: symbol) {
    if (this.owner !== owner) return;
    this.owner = null;
    this.element?.pause();
  }
}

export const playbackHub = new PlaybackHub();

/**
 * Renders a host for the shared video. The video is appended into the host on
 * mount and follows `src` / `playing` / `muted` afterwards. `className` is put
 * on the video itself (e.g. "media"), while the host takes no layout space.
 */
export function HubVideo({
  src,
  playing = true,
  muted = true,
  loop = true,
  className = '',
  onVideo,
  onError,
  onClick,
}: {
  src: string;
  playing?: boolean;
  muted?: boolean;
  loop?: boolean;
  className?: string;
  onVideo?: (video: HTMLVideoElement) => void;
  onError?: () => void;
  onClick?: (event: ReactMouseEvent) => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const owner = useRef<symbol>(Symbol('playback'));
  const callbacks = useRef({ onVideo, onError });
  callbacks.current = { onVideo, onError };

  useEffect(() => {
    const id = owner.current;
    const video = playbackHub.claim(id, src, { playing, muted, loop, className });
    host.current?.appendChild(video);
    callbacks.current.onVideo?.(video);
    const failed = () => callbacks.current.onError?.();
    video.addEventListener('error', failed);
    return () => {
      video.removeEventListener('error', failed);
      playbackHub.release(id);
    };
    // `playing`/`muted`/`loop` are applied by the effect below; only a new
    // source or element needs the full claim.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    playbackHub.configure(owner.current, { playing, muted, loop, className });
  }, [playing, muted, loop, className]);

  return <span ref={host} className="hub-video-host" onClick={onClick} />;
}
