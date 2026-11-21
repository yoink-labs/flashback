// Player colours and avatars. A player keeps the same colour everywhere: the
// lobby, the guess grid, and the results.
import type { RoomView } from '../types';

/** Twelve vivid colours, assigned by join order (the server sorts by joinSeq). */
export const PLAYER_COLORS = [
  '#FF6B6B',
  '#FFB547',
  '#FFE066',
  '#6BE675',
  '#2EE5C5',
  '#4FC3FF',
  '#7C8CFF',
  '#B07CFF',
  '#FF7AD9',
  '#FF9A5A',
  '#B7E34A',
  '#D9D6E0',
] as const;

export const playerColor = (index: number) => PLAYER_COLORS[((index % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];

export const playerIndex = (view: Pick<RoomView, 'players'>, id: string) => Math.max(0, view.players.findIndex((player) => player.id === id));

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export function Avatar({
  name,
  colorIndex,
  size = 'md',
  dimmed = false,
  offline = false,
  ready = false,
  gold = false,
}: {
  name: string;
  colorIndex: number;
  size?: AvatarSize;
  dimmed?: boolean;
  offline?: boolean;
  ready?: boolean;
  gold?: boolean;
}) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '?';
  const ring = [ready ? 'avatar-ready' : '', gold ? 'avatar-gold' : '', dimmed ? 'avatar-dimmed' : '', offline ? 'avatar-offline' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={`avatar avatar-${size}${ring ? ` ${ring}` : ''}`} style={{ background: playerColor(colorIndex) }} aria-hidden="true">
      {initial}
    </span>
  );
}
