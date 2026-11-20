// Server-side media limits and validation. Clients compress and trim before
// upload; the server checks again and never trusts declared sizes or types.
export type MediaKind = 'photo' | 'video';
export type MediaMode = 'photos' | 'videos' | 'both';

export const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 8 * 1024 * 1024;
export const VIDEO_MIN_MS = 1_000;
/** Clips target 5–8 seconds; allow a little muxer slack over 8 s. */
export const VIDEO_MAX_MS = 8_500;
export const ITEMS_PER_PLAYER = 10;
/** Backstop only. Media is deleted when its round, the game, or the room ends. */
export const MEDIA_TTL_MS = 2 * 60 * 60 * 1000;

export class MediaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const kindAllowed = (mode: MediaMode, kind: MediaKind) => mode === 'both' || (mode === 'photos' ? kind === 'photo' : kind === 'video');

export function kindForContentType(contentType: string | null): MediaKind {
  const type = contentType?.split(';')[0].trim().toLowerCase();
  if (type === 'image/jpeg') return 'photo';
  if (type === 'video/mp4') return 'video';
  throw new MediaError(415, 'Upload a JPEG photo or an MP4 video clip.');
}

export function maxBytes(kind: MediaKind) {
  return kind === 'photo' ? PHOTO_MAX_BYTES : VIDEO_MAX_BYTES;
}

/** Validates bytes for a kind. Returns the bytes to store (photos lose EXIF/XMP). */
export function validateMedia(kind: MediaKind, bytes: Uint8Array): { bytes: Uint8Array; durationMs?: number } {
  if (bytes.length === 0) throw new MediaError(422, 'That file is empty.');
  if (bytes.length > maxBytes(kind)) throw new MediaError(413, kind === 'photo' ? 'Photos must be 3 MB or smaller.' : 'Video clips must be 8 MB or smaller.');
  if (kind === 'photo') return { bytes: stripJpegMetadata(bytes) };
  const info = inspectMp4(bytes);
  if (!info) throw new MediaError(422, 'Upload an MP4 video clip.');
  if (!info.h264) throw new MediaError(422, 'Video clips must use H.264.');
  if (info.durationMs < VIDEO_MIN_MS || info.durationMs > VIDEO_MAX_MS) throw new MediaError(422, 'Video clips must be between 1 and 8 seconds.');
  return { bytes, durationMs: info.durationMs };
}

// ---- MP4 ----

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const text = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function boxes(bytes: Uint8Array, view: DataView, from: number, to: number): Box[] | null {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = text(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      const big = view.getBigUint64(at + 8);
      if (big > BigInt(to - at)) return null;
      size = Number(big);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return null;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

export function inspectMp4(bytes: Uint8Array): { durationMs: number; h264: boolean } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(bytes, view, 0, bytes.length);
  if (!top || top[0]?.type !== 'ftyp') return null;
  let durationMs: number | null = null;
  let h264 = false;
  const walk = (list: Box[]): boolean => {
    for (const box of list) {
      if (box.type === 'mvhd') {
        const version = bytes[box.start];
        const base = box.start + 4;
        if (version === 1) {
          if (base + 28 > box.end) return false;
          const timescale = view.getUint32(base + 16);
          const duration = Number(view.getBigUint64(base + 20));
          if (!timescale) return false;
          durationMs = Math.round((duration * 1000) / timescale);
        } else {
          if (base + 16 > box.end) return false;
          const timescale = view.getUint32(base + 8);
          const duration = view.getUint32(base + 12);
          if (!timescale) return false;
          durationMs = Math.round((duration * 1000) / timescale);
        }
      } else if (box.type === 'stsd') {
        const entries = boxes(bytes, view, box.start + 8, box.end);
        if (!entries) return false;
        if (entries.some((e) => e.type === 'avc1' || e.type === 'avc3')) h264 = true;
      } else if (CONTAINERS.has(box.type)) {
        const children = boxes(bytes, view, box.start, box.end);
        if (!children || !walk(children)) return false;
      }
    }
    return true;
  };
  if (!walk(top) || durationMs === null) return null;
  return { durationMs, h264 };
}

// ---- JPEG ----

/**
 * Removes APP1 (EXIF/XMP, which can carry GPS), APP13 (IPTC), and comment
 * segments from a JPEG. Throws if the bytes are not a JPEG.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new MediaError(422, 'Upload a JPEG photo.');
  const keep: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) throw new MediaError(422, 'That photo looks damaged.');
    let marker = bytes[at + 1];
    while (marker === 0xff && at + 2 < bytes.length) marker = bytes[++at + 1];
    if (marker === 0xd9) {
      keep.push(bytes.subarray(at, at + 2));
      at += 2;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push(bytes.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > bytes.length) throw new MediaError(422, 'That photo looks damaged.');
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2 || at + 2 + length > bytes.length) throw new MediaError(422, 'That photo looks damaged.');
    const segment = bytes.subarray(at, at + 2 + length);
    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded image data.
      keep.push(bytes.subarray(at));
      at = bytes.length;
      break;
    }
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) keep.push(segment);
    at += 2 + length;
  }
  const out = new Uint8Array(keep.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of keep) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
