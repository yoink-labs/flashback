// Nicknames are display-only: 1–24 visible characters after trimming, unique
// within a room ignoring case.
export const NICKNAME_MAX = 24;

export class NicknameError extends Error {}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Visible characters (grapheme clusters), so "👍🏽" counts as one. */
export const visibleLength = (text: string) => [...segmenter.segment(text)].length;

export function normalizeNickname(input: unknown): string {
  if (typeof input !== 'string') throw new NicknameError('Choose a nickname.');
  // Drop control and invisible formatting characters, then collapse whitespace.
  const cleaned = input
    .normalize('NFC')
    .replace(/[\p{Cc}​-‍⁠﻿]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) throw new NicknameError('Choose a nickname.');
  if (visibleLength(cleaned) > NICKNAME_MAX) throw new NicknameError(`Nicknames can be up to ${NICKNAME_MAX} characters.`);
  return cleaned;
}

export const nicknameKey = (nickname: string) => nickname.normalize('NFKC').toLocaleLowerCase('en-US');

export function assertUniqueNickname(nickname: string, taken: Iterable<string>) {
  const key = nicknameKey(nickname);
  for (const other of taken) if (nicknameKey(other) === key) throw new NicknameError(`“${nickname}” is already in this room. Pick another nickname.`);
}
