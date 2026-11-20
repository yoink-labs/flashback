// Client-side media preparation so web players match iOS players:
//   • Photos: decoded, resized to 1600 px on the long edge, re-encoded as JPEG.
//     Re-encoding drops EXIF, including GPS.
//   • Videos: a random 6-second window (shorter if the video is shorter) is
//     re-encoded to an H.264 MP4 of at most 8 MB, up to 720p, with AAC audio when
//     the browser can encode it. Uses WebCodecs and mp4-muxer (MIT).
// Originals are never uploaded. If a browser cannot transcode, the player sees a
// clear error and nothing is sent.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export const LIMITS = {
  photoMaxBytes: 3 * 1024 * 1024,
  photoMaxEdge: 1600,
  videoMaxBytes: 8 * 1024 * 1024,
  videoMaxEdge: 720,
  clipTargetSeconds: 6,
  clipMinSeconds: 1,
  clipMaxSeconds: 8,
  /** Larger files skip audio extraction so we never load huge files into memory. */
  audioDecodeMaxBytes: 150 * 1024 * 1024,
} as const;

export class MediaPrepError extends Error {}

/** The clip window: up to 6 s from a random start. Mirrors MediaConstraints.clipRange on iOS. */
export function clipWindow(durationSeconds: number, random = Math.random) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < LIMITS.clipMinSeconds) throw new MediaPrepError('That video is too short. Pick one that is at least a second long.');
  const length = Math.min(LIMITS.clipTargetSeconds, durationSeconds);
  const start = (durationSeconds - length) * random();
  return { start, length };
}

export function fitWithin(width: number, height: number, maxEdge: number, even = false) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  let w = Math.max(1, Math.round(width * scale));
  let h = Math.max(1, Math.round(height * scale));
  if (even) {
    w -= w % 2;
    h -= h % 2;
  }
  return { width: Math.max(2, w), height: Math.max(2, h) };
}

export const isVideoFile = (file: File) => file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);

// ---- photos ----

export async function preparePhoto(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new MediaPrepError(`This browser can't open “${file.name}”. Try a JPEG or PNG.`);
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height, LIMITS.photoMaxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= LIMITS.photoMaxBytes) return blob;
  }
  throw new MediaPrepError('That photo is too large even after compressing.');
}

// ---- videos ----

const H264_CODECS = ['avc1.42001f', 'avc1.4d401f', 'avc1.640028'];

async function pickVideoConfig(width: number, height: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const codec of H264_CODECS) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate: 2_000_000, framerate: 30, avc: { format: 'avc' } };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {}
  }
  return null;
}

async function pickAudioConfig(sampleRate: number, numberOfChannels: number): Promise<AudioEncoderConfig | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const config: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 96_000 };
  try {
    return (await AudioEncoder.isConfigSupported(config)).supported ? config : null;
  } catch {
    return null;
  }
}

function loadVideo(file: File) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const url = URL.createObjectURL(file);
  video.src = url;
  const ready = new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new MediaPrepError(`This browser can't read “${file.name}”. Try a shorter MP4 or MOV clip.`));
  });
  return { video, ready, dispose: () => (video.removeAttribute('src'), video.load(), URL.revokeObjectURL(url)) };
}

const seek = (video: HTMLVideoElement, time: number) =>
  new Promise<void>((resolve) => {
    if (Math.abs(video.currentTime - time) < 0.01) return resolve();
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = time;
  });

/** Decodes the clip's audio window, or null if the browser cannot. */
async function decodeAudioWindow(file: File, start: number, length: number) {
  if (file.size > LIMITS.audioDecodeMaxBytes || typeof OfflineAudioContext === 'undefined') return null;
  try {
    const context = new OfflineAudioContext(2, 1, 48_000);
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const channels = Math.min(2, buffer.numberOfChannels);
    const from = Math.floor(start * buffer.sampleRate);
    const frames = Math.min(buffer.length - from, Math.floor(length * buffer.sampleRate));
    if (frames <= 0) return null;
    const planes = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c).slice(from, from + frames));
    return { sampleRate: buffer.sampleRate, channels, frames, planes };
  } catch {
    return null;
  }
}

export async function prepareVideo(file: File, onProgress?: (fraction: number) => void, random = Math.random): Promise<Blob> {
  const source = loadVideo(file);
  try {
    await source.ready;
    const { video } = source;
    const { start, length } = clipWindow(video.duration, random);
    const size = fitWithin(video.videoWidth || 1280, video.videoHeight || 720, LIMITS.videoMaxEdge, true);
    const videoConfig = await pickVideoConfig(size.width, size.height);
    if (!videoConfig)
      throw new MediaPrepError("This browser can't convert videos to the shared clip format. Try the latest Chrome, Edge, or Safari, or add photos instead.");
    const audio = await decodeAudioWindow(file, start, length);
    const audioConfig = audio && (await pickAudioConfig(audio.sampleRate, audio.channels));

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
      video: { codec: 'avc', width: size.width, height: size.height, frameRate: 30 },
      ...(audioConfig ? { audio: { codec: 'aac' as const, numberOfChannels: audio!.channels, sampleRate: audio!.sampleRate } } : {}),
    });
    let failure: unknown = null;
    const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failure = e) });
    videoEncoder.configure(videoConfig);

    // Frames: play the window in real time and sample at up to 30 fps.
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d')!;
    await seek(video, start);
    let frames = 0;
    let lastTime = -1;
    const end = start + length;
    const capture = (mediaTime: number) => {
      if (mediaTime < start - 0.05 || mediaTime - lastTime < 1 / 31 || mediaTime > end) return;
      lastTime = mediaTime;
      context.drawImage(video, 0, 0, size.width, size.height);
      const frame = new VideoFrame(canvas, { timestamp: Math.max(0, Math.round((mediaTime - start) * 1e6)) });
      videoEncoder.encode(frame, { keyFrame: frames % 60 === 0 });
      frame.close();
      frames += 1;
      onProgress?.(Math.min(0.95, (mediaTime - start) / length));
    };
    await new Promise<void>((resolve, reject) => {
      const done = () => (video.pause(), resolve());
      const timeout = setTimeout(done, (length + 10) * 1000);
      video.onended = () => (clearTimeout(timeout), done());
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        const step = (_: number, meta: VideoFrameCallbackMetadata) => {
          capture(meta.mediaTime);
          if (meta.mediaTime >= end || video.ended) return clearTimeout(timeout), done();
          video.requestVideoFrameCallback(step);
        };
        video.requestVideoFrameCallback(step);
      } else {
        const timer = setInterval(() => {
          capture(video.currentTime);
          if (video.currentTime >= end || video.ended) clearInterval(timer), clearTimeout(timeout), done();
        }, 1000 / 30);
      }
      video.play().catch(() => reject(new MediaPrepError('This browser would not play that video for conversion. Try another clip.')));
    });
    await videoEncoder.flush();
    videoEncoder.close();
    if (!frames) throw new MediaPrepError("Couldn't read frames from that video. Try another clip.");

    if (audioConfig && audio) {
      const audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => (failure = e) });
      audioEncoder.configure(audioConfig);
      const block = 1024;
      for (let offset = 0; offset < audio.frames; offset += block) {
        const count = Math.min(block, audio.frames - offset);
        const data = new Float32Array(count * audio.channels);
        for (let c = 0; c < audio.channels; c++) data.set(audio.planes[c].subarray(offset, offset + count), c * count);
        const chunk = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: count, numberOfChannels: audio.channels, timestamp: Math.round((offset / audio.sampleRate) * 1e6), data });
        audioEncoder.encode(chunk);
        chunk.close();
      }
      await audioEncoder.flush();
      audioEncoder.close();
    }
    if (failure) throw new MediaPrepError("This browser couldn't convert that video. Try a shorter clip, or add photos instead.");
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    if (blob.size > LIMITS.videoMaxBytes) throw new MediaPrepError('That clip is still over 8 MB after converting. Try a shorter or smaller video.');
    onProgress?.(1);
    return blob;
  } finally {
    source.dispose();
  }
}
