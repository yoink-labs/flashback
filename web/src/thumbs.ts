// Small square thumbnails for the bunch grid, made once per item and cached.
//
// Full-size camera photos are 12–48 MP; putting 12 of them in <img> tags makes
// phones decode (and keep) hundreds of megabytes. Instead each item is decoded
// once, centre-cropped to a 400 px square JPEG, and the original bitmap is
// dropped. Videos get a poster frame the same way (and their duration), so the
// grid never holds a live <video>. At most two thumbnails are made at a time.
import { useEffect, useState } from 'react';
import { decodeImage } from './media';
import type { MediaKind } from './types';

export interface Thumb {
  url: string | null;
  /** Video length in seconds, when known. */
  seconds?: number;
  failed?: boolean;
}

const EDGE = 400;
const cache = new Map<string, Thumb>();
const pending = new Map<string, Promise<Thumb>>();
const listeners = new Map<string, Set<(thumb: Thumb) => void>>();
let running = 0;
let generation = 0;
const waiting: Array<() => void> = [];

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function squareJPEG(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  const side = Math.min(width, height);
  if (!side) return Promise.resolve(null);
  const edge = Math.min(EDGE, side);
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, edge, edge);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/jpeg', 0.82));
}

/** A photo this browser can't decode (e.g. HEIC in Chrome) is `failed`: the deck deals another. */
async function photoThumb(file: File): Promise<Thumb> {
  try {
    const image = await decodeImage(file);
    try {
      return { url: await squareJPEG(image.source, image.width, image.height) };
    } finally {
      image.close();
    }
  } catch {
    return { url: null, failed: true };
  }
}

function videoThumb(file: File): Promise<Thumb> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const source = URL.createObjectURL(file);
    let seconds: number | undefined;
    let done = false;
    const finish = (thumb: Thumb) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(source);
      resolve(thumb);
    };
    const timeout = setTimeout(() => finish({ url: null, seconds, failed: seconds === undefined }), 8000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => {
      seconds = Number.isFinite(video.duration) ? video.duration : undefined;
      try {
        video.currentTime = Math.min(0.5, (video.duration || 1) / 3);
      } catch {
        finish({ url: null, seconds });
      }
    };
    video.onseeked = () => {
      void squareJPEG(video, video.videoWidth, video.videoHeight).then((url) => finish({ url, seconds }));
    };
    video.onerror = () => finish({ url: null, failed: true });
    video.src = source;
  });
}

/** Starts (or joins) making the thumbnail for one item. */
export function loadThumb(id: string, file: File, kind: MediaKind): Promise<Thumb> {
  const cached = cache.get(id);
  if (cached) return Promise.resolve(cached);
  let job = pending.get(id);
  if (!job) {
    const made = generation;
    job = slot(() => (kind === 'photo' ? photoThumb(file) : videoThumb(file))).then((thumb) => {
      if (made !== generation) {
        if (thumb.url) URL.revokeObjectURL(thumb.url);
        return thumb;
      }
      pending.delete(id);
      cache.set(id, thumb);
      listeners.get(id)?.forEach((listener) => listener(thumb));
      return thumb;
    });
    pending.set(id, job);
  }
  return job;
}

/** The cached thumbnail for an item, made on first use. */
export function useThumb(id: string, file: File, kind: MediaKind): Thumb | undefined {
  const [thumb, setThumb] = useState<Thumb | undefined>(() => cache.get(id));
  useEffect(() => {
    const cached = cache.get(id);
    if (cached) {
      setThumb(cached);
      return;
    }
    setThumb(undefined);
    const set = listeners.get(id) ?? new Set();
    set.add(setThumb);
    listeners.set(id, set);
    void loadThumb(id, file, kind);
    return () => {
      set.delete(setThumb);
      if (!set.size) listeners.delete(id);
    };
  }, [id, file, kind]);
  return thumb;
}

/** Revokes every cached thumbnail (when the room goes away). */
export function releaseThumbs() {
  for (const thumb of cache.values()) if (thumb.url) URL.revokeObjectURL(thumb.url);
  cache.clear();
  pending.clear();
  generation += 1;
}
