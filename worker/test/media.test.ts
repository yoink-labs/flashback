import { describe, expect, it } from 'vitest';
import { inspectMp4, kindAllowed, kindForContentType, PHOTO_MAX_BYTES, stripJpegMetadata, validateMedia, VIDEO_MAX_BYTES } from '../src/media';
import { fakeJpeg, fakeMp4 } from './helpers';

describe('media constraints', () => {
  it('maps media modes to allowed kinds', () => {
    expect(kindAllowed('photos', 'photo')).toBe(true);
    expect(kindAllowed('photos', 'video')).toBe(false);
    expect(kindAllowed('videos', 'video')).toBe(true);
    expect(kindAllowed('videos', 'photo')).toBe(false);
    expect(kindAllowed('both', 'photo') && kindAllowed('both', 'video')).toBe(true);
  });

  it('accepts only JPEG photos and MP4 clips', () => {
    expect(kindForContentType('image/jpeg')).toBe('photo');
    expect(kindForContentType('video/mp4; codecs="avc1"')).toBe('video');
    for (const type of ['image/heic', 'video/quicktime', 'image/png', null]) expect(() => kindForContentType(type)).toThrow(/JPEG photo or an MP4/);
  });

  it('reads MP4 duration and codec', () => {
    expect(inspectMp4(fakeMp4({ durationMs: 6000 }))).toEqual({ durationMs: 6000, h264: true });
    expect(inspectMp4(fakeMp4({ codec: 'hvc1' }))).toEqual({ durationMs: 6000, h264: false });
    expect(inspectMp4(fakeJpeg())).toBeNull();
    expect(inspectMp4(fakeMp4().subarray(0, 40))).toBeNull();
  });

  it('enforces clip duration, codec, and size limits on the server', () => {
    expect(validateMedia('video', fakeMp4({ durationMs: 6000 })).durationMs).toBe(6000);
    expect(validateMedia('video', fakeMp4({ durationMs: 8000 })).durationMs).toBe(8000);
    expect(() => validateMedia('video', fakeMp4({ durationMs: 30_000 }))).toThrow(/between 1 and 8 seconds/);
    expect(() => validateMedia('video', fakeMp4({ durationMs: 500 }))).toThrow(/between 1 and 8 seconds/);
    expect(() => validateMedia('video', fakeMp4({ codec: 'hvc1' }))).toThrow(/H.264/);
    expect(() => validateMedia('video', fakeMp4({ padding: VIDEO_MAX_BYTES }))).toThrow(/8 MB/);
    expect(() => validateMedia('video', fakeJpeg())).toThrow(/MP4/);
    expect(() => validateMedia('photo', fakeJpeg({ padding: PHOTO_MAX_BYTES }))).toThrow(/3 MB/);
    expect(() => validateMedia('photo', new Uint8Array())).toThrow(/empty/);
    expect(() => validateMedia('photo', fakeMp4())).toThrow(/JPEG/);
  });

  it('strips EXIF/GPS and comments from photos but keeps the image data', () => {
    const original = fakeJpeg();
    const stripped = stripJpegMetadata(original);
    const text = new TextDecoder('latin1').decode(stripped);
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('secret comment');
    expect(text).toContain('JFIF');
    expect(stripped.length).toBe(fakeJpeg({ exif: false }).length);
    expect(stripped.subarray(-2)).toEqual(new Uint8Array([0xff, 0xd9]));
  });
});
