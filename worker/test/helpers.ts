import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';

const ascii = (s: string) => new TextEncoder().encode(s);
function box(type: string, ...parts: Uint8Array[]) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(ascii(type), 4);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const u32 = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
};

/** A structurally valid (not playable) MP4 with the given duration and video codec. */
export function fakeMp4({ durationMs = 6000, codec = 'avc1', timescale = 600, padding = 0 }: { durationMs?: number; codec?: string; timescale?: number; padding?: number } = {}) {
  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isomavc1mp41'));
  const mvhd = box('mvhd', u32(0, 0, 0, timescale, Math.round((durationMs * timescale) / 1000)), new Uint8Array(80));
  const sampleEntry = box(codec, new Uint8Array(78));
  const stsd = box('stsd', u32(0, 1), sampleEntry);
  const moov = box('moov', mvhd, box('trak', box('mdia', box('minf', box('stbl', stsd)))));
  const mdat = box('mdat', new Uint8Array(padding));
  return concat(ftyp, moov, mdat);
}

export function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const segment = (marker: number, payload: Uint8Array) => concat(new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload);

/** A minimal JPEG byte stream with JFIF, an EXIF (GPS-bearing) APP1, a comment, and scan data. */
export function fakeJpeg({ exif = true, padding = 0 }: { exif?: boolean; padding?: number } = {}) {
  return concat(
    new Uint8Array([0xff, 0xd8]),
    segment(0xe0, ascii('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...(exif ? [segment(0xe1, ascii('Exif\0\0GPSLatitude=37.7749')), segment(0xfe, ascii('secret comment'))] : []),
    segment(0xdb, new Uint8Array(65)),
    segment(0xda, new Uint8Array(10)),
    new Uint8Array(padding + 16).fill(0x42),
    new Uint8Array([0xff, 0xd9]),
  );
}

/** A local Clerk-like signer: RS256 keys and a JWKS resolver. No real secrets. */
export async function clerkFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  async function sign(claims: Record<string, unknown> = {}, options: { issuer?: string; sub?: string | null; expiresIn?: string; iat?: boolean; alg?: string } = {}) {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(options.issuer ?? 'https://clerk.yoinklabs.dev');
    if (options.sub !== null) jwt = jwt.setSubject(options.sub ?? 'user_123');
    if (options.iat !== false) jwt = jwt.setIssuedAt();
    jwt = jwt.setExpirationTime(options.expiresIn ?? '5m');
    return jwt.sign(privateKey);
  }
  return { jwks, sign };
}

export function sequenceRandom() {
  let n = 0;
  return { float: () => 0, id: () => String(++n).padStart(6, '0') + 'f'.repeat(26) };
}
