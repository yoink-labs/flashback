// Pure settings rules that both the sheet and the tests use. No DOM/React, so
// it runs under `node --test` (web/test).
import type { RoomEffects } from './types';

/**
 * The server rejects a blur whose `after` is not greater than greyscale's when
 * both are on with the same trigger ("Blur has to start after greyscale.").
 * Nudge the pair into a valid one before it is sent, so the host never sees a
 * 422 for a choice the sheet appeared to allow.
 */
export function validEffects(effects: RoomEffects): RoomEffects {
  const { greyscale, blur } = effects;
  if (!greyscale.enabled || !blur.enabled || greyscale.trigger !== blur.trigger || blur.after > greyscale.after) return effects;
  const after = Math.min(10, greyscale.after + 1);
  if (after > greyscale.after) return { ...effects, blur: { ...blur, after } };
  return { ...effects, greyscale: { ...greyscale, after: Math.max(2, blur.after - 1) } };
}

/**
 * Whether a 50/50 can cut anyone this round. Wrong choices are everyone but
 * the owner and the viewer, so a non-owner needs at least four players; the
 * owner of a 3-player room could, but the owner is hidden during the reveal,
 * so the client conservatively disables it below four players (the server
 * answers 409 "There is nobody to cut this round." and keeps the charge).
 */
export const fiftyFiftyPlayable = (playerCount: number) => playerCount - 2 >= 2;
