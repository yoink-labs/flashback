// The small public power-up icons shown beside a player's avatar everywhere
// (docs/MILESTONE4.md §6: guess grid, lobby, results rows). No names, no counts
// beyond the 50/50's ×2.
import type { PlayerItems } from '../types';
import { DieIcon, ScissorsIcon, ShieldIcon } from './Icons';

const nameOf = (item: 'doubleDown' | 'shield' | 'fiftyFifty') =>
  item === 'doubleDown' ? 'Double Down' : item === 'shield' ? 'Shield' : '50/50';

export function ItemIcons({ items, className = '' }: { items?: PlayerItems; className?: string }) {
  if (!items) return null;
  const held = (['doubleDown', 'shield', 'fiftyFifty'] as const).filter((item) => items[item] > 0);
  if (!held.length) return null;
  const label = held.map((item) => (item === 'fiftyFifty' && items.fiftyFifty > 1 ? '2 × 50/50' : nameOf(item))).join(', ');
  return (
    <span className={`item-icons ${className}`.trim()} aria-label={label} title={label}>
      {items.doubleDown > 0 && (
        <span className="item-icon">
          <DieIcon size={13} />
        </span>
      )}
      {items.shield > 0 && (
        <span className="item-icon">
          <ShieldIcon size={13} />
        </span>
      )}
      {items.fiftyFifty > 0 && (
        <span className="item-icon">
          <ScissorsIcon size={13} />
          {items.fiftyFifty > 1 && <span className="item-count">2</span>}
        </span>
      )}
    </span>
  );
}
