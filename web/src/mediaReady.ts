// "Decoded and ready to show" for a round's media (docs/MILESTONE5.md §3).
// Photos are decoded off-DOM with an <img>; videos are pulled into an off-DOM
// <video> until a frame is decodable (`loadeddata` / `canplay`). The result
// includes the media's natural size, which sizes the reveal's aspect box.
import type { MediaKind } from './types';

export interface MediaSize {
  width: number;
  height: number;
}

/** Readiness is per object URL, so a visible element starting later is free. */
const pending = new Map<string, Promise<MediaSize>>();

/** Resolves when the media can be painted (or rejects if it never can). */
export function awaitMediaReady(entry: { url: string; kind: MediaKind }): Promise<MediaSize> {
  const cached = pending.get(entry.url);
  if (cached) return cached;
  const promise = entry.kind === 'video' ? videoReady(entry.url) : photoReady(entry.url);
  pending.set(entry.url, promise);
  return promise;
}

function photoReady(url: string): Promise<MediaSize> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
    };
    const timer = setTimeout(() => finish(), 10_000);
    image.decoding = 'async';
    image.onload = () => finish();
    image.onerror = () => finish(new Error('That photo did not decode.'));
    image.src = url;
    // `decode()` says the frame can be painted; onload covers older browsers.
    void image.decode?.().then(() => finish(), () => {});
  });
}

function videoReady(url: string): Promise<MediaSize> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {}
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      const size = { width: video.videoWidth || 0, height: video.videoHeight || 0 };
      cleanup();
      if (error) reject(error);
      else resolve(size);
    };
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('loadeddata', () => finish(), { once: true });
    video.addEventListener('canplay', () => finish(), { once: true });
    video.addEventListener('error', () => finish(new Error('That clip did not load.')), { once: true });
    timer = setTimeout(() => finish(), 10_000);
    video.src = url;
    video.load();
  });
}
