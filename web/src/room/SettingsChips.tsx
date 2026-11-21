// The lobby's row of small "what is on" chips, under the settings summary
// (docs/MILESTONE4.md §9). The same chips sit in the join preview.
import type { ReactNode } from 'react';
import type { RoomSettings } from '../types';
import { BlurIcon, CartIcon, EvenSplitIcon, FocusIcon, GreyscaleIcon, ScissorsIcon, ZoomIcon } from '../ui/Icons';

export interface SettingChip {
  key: string;
  label: string;
  /** Spoken / hover explanation, since the chips are terse. */
  title: string;
  icon: ReactNode;
}

/** Everything enabled in the settings, as short chips. Pure, so it is unit-tested. */
export function enabledChips(settings: RoomSettings): SettingChip[] {
  const chips: SettingChip[] = [];
  const arrow = (trigger: 'right' | 'wrong') => (trigger === 'right' ? '↑' : '↓');
  const effectChips = [
    {
      key: 'greyscale',
      enabled: settings.effects.greyscale.enabled,
      label: `Greyscale ${settings.effects.greyscale.after}${arrow(settings.effects.greyscale.trigger)}`,
      title: `Greyscale after ${settings.effects.greyscale.after} ${settings.effects.greyscale.trigger} guesses in a row`,
      icon: <GreyscaleIcon size={14} />,
    },
    {
      key: 'blur',
      enabled: settings.effects.blur.enabled,
      label: `Blur ${settings.effects.blur.after}${arrow(settings.effects.blur.trigger)}`,
      title: `Blur after ${settings.effects.blur.after} ${settings.effects.blur.trigger} guesses in a row`,
      icon: <BlurIcon size={14} />,
    },
    {
      key: 'focus',
      enabled: settings.effects.focus.enabled,
      label: 'Focus',
      title: settings.effects.focus.frequency === 'every' ? 'Focus on every round' : 'Focus on half the rounds',
      icon: <FocusIcon size={14} />,
    },
    {
      key: 'zoom',
      enabled: settings.effects.zoom.enabled,
      label: 'Zoom-out',
      title: settings.effects.zoom.frequency === 'every' ? 'Zoom-out on every round' : 'Zoom-out on half the rounds',
      icon: <ZoomIcon size={14} />,
    },
    {
      key: 'fiftyFifty',
      enabled: settings.powerups.fiftyFifty.enabled,
      label: '50/50',
      title: `A 50/50 for every ${settings.powerups.fiftyFifty.after} correct guesses in a row`,
      icon: <ScissorsIcon size={14} />,
    },
    {
      key: 'shop',
      enabled: settings.powerups.shop.enabled,
      label: 'Shop',
      title: 'A shop between rounds',
      icon: <CartIcon size={14} />,
    },
  ];
  for (const chip of effectChips) if (chip.enabled) chips.push(chip);
  if (settings.evenSplit)
    chips.unshift({
      key: 'evenSplit',
      label: 'Even Split',
      title: 'Everyone deals rounds ÷ players. Every photo gets shown.',
      icon: <EvenSplitIcon size={14} />,
    });
  return chips.map(({ key, label, title, icon }) => ({ key, label, title, icon }));
}

export function SettingsChips({ settings, className = '' }: { settings: RoomSettings; className?: string }) {
  const chips = enabledChips(settings);
  if (!chips.length) return null;
  return (
    <ul className={`flag-chips ${className}`.trim()} aria-label="Game extras" data-testid="settings-chips">
      {chips.map((chip) => (
        <li key={chip.key} className="flag-chip" title={chip.title}>
          <span className="flag-chip-icon" aria-hidden="true">
            {chip.icon}
          </span>
          {chip.label}
        </li>
      ))}
    </ul>
  );
}
