// Room codes: 6 characters from an alphabet without look-alikes (no 0/O, 1/I/L).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Uniform random code. `randomBytes` is injectable for tests. */
export function generateCode(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  let code = '';
  // Rejection sampling keeps the distribution uniform over the alphabet.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      if (byte >= limit) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** Accepts user input such as " abc-123 " and returns the canonical code, or null. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

export const isValidCode = (input: unknown): input is string => typeof input === 'string' && CODE_PATTERN.test(input);

export function joinURL(webURL: string, code: string) {
  return `${webURL.replace(/\/$/, '')}/join/${code}`;
}

export function defaultRandomBytes(n: number) {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random identifier with `bytes` of entropy. */
export function randomID(bytes = 16, randomBytes: (n: number) => Uint8Array = defaultRandomBytes) {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
