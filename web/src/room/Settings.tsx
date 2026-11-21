// One quiet settings row in the lobby. The host opens a sheet (a bottom sheet
// on phones, a dialog on wide screens) to change everything; everyone else
// just reads the summary. docs/MILESTONE4.md §9 groups it into Game, Effects
// and Power-ups, with every effect row expanding when it is switched on.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_PRICES,
  SHOP_MIN_BREAK_SECONDS,
  type BlurStrength,
  type ClientMessage,
  type EffectFrequency,
  type EffectTrigger,
  type MediaMode,
  type RoomEffects,
  type RoomSettings,
  type ShopItem,
} from '../types';
import { BlurIcon, CartIcon, ChevronIcon, EvenSplitIcon, FocusIcon, GreyscaleIcon, ScissorsIcon, SlidersIcon, ZoomIcon } from '../ui/Icons';
import { useModal } from '../ui/useModal';
import { validEffects } from '../settingsModel';

const MODES: { value: MediaMode; label: string }[] = [
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'both', label: 'Mix' },
];

const ROUND_CHIPS = [5, 10, 20, 30, 50, 100];
const TIMERS = [10, 15, 20, 30, 45, 60];
const BREAKS = [3, 5, 7, 10, 15, 20, 30];
const SWAPS = [0, 1, 3, 5];
const SPANS = [25, 50, 75, 100] as const;
const SCALES = [2, 3, 4] as const;
const TRIGGERS: { value: EffectTrigger; label: string }[] = [
  { value: 'right', label: 'Right streak' },
  { value: 'wrong', label: 'Wrong streak' },
];
const FREQUENCIES: { value: EffectFrequency; label: string }[] = [
  { value: 'every', label: 'Every round' },
  { value: 'half', label: 'Half the rounds' },
];
const STRENGTHS: { value: BlurStrength; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'heavy', label: 'Heavy' },
];

/** "Photos" / "Videos" / "Mix": the one word for a mode everywhere (lobby row, join preview). */
export const modeWord = (mode: MediaMode) => MODES.find((entry) => entry.value === mode)?.label ?? 'Mix';

export const settingsSummary = (settings: RoomSettings) =>
  `${modeWord(settings.mediaMode)} · ${settings.rounds} ${settings.rounds === 1 ? 'round' : 'rounds'} · ${settings.timerSeconds}s`;

/** Chip values, plus the current value if a different client set an odd one. */
const withValue = (values: number[], value: number) => (values.includes(value) ? values : [...values, value].sort((a, b) => a - b));

export function Settings({
  settings,
  isHost,
  send,
}: {
  settings: RoomSettings;
  isHost: boolean;
  send: (message: ClientMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = settingsSummary(settings);

  if (!isHost) {
    return (
      <div className="settings-row static" data-testid="settings-summary">
        <SlidersIcon />
        <span className="settings-row-text">{summary}</span>
      </div>
    );
  }

  return (
    <>
      <button type="button" className="settings-row" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="settings-row">
        <SlidersIcon />
        <span className="settings-row-text">{summary}</span>
        <ChevronIcon />
      </button>
      {open && <Sheet settings={settings} send={send} onClose={() => setOpen(false)} />}
    </>
  );
}

function Sheet({ settings, send, onClose }: { settings: RoomSettings; send: (message: ClientMessage) => void; onClose: () => void }) {
  const set = (patch: Partial<RoomSettings>) => send({ type: 'settings', ...patch });
  const setEffects = (effects: RoomEffects) => send({ type: 'settings', effects: validEffects(effects) });
  const effects = settings.effects;
  const powerups = settings.powerups;
  const sheet = useRef<HTMLDivElement>(null);

  useModal(onClose);
  useEffect(() => sheet.current?.focus(), []);

  const patchEffect = <K extends keyof RoomEffects>(key: K, patch: Partial<RoomEffects[K]>) =>
    setEffects({ ...effects, [key]: { ...effects[key], ...patch } });

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheet}
        tabIndex={-1}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
        data-testid="settings-sheet"
      >
        <span className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id="settings-title" className="headline">
            Game settings
          </h2>
          <button type="button" className="sheet-done" onClick={onClose}>
            Done
          </button>
        </div>

        <Group title="Game">
          <div className="setting">
            <span className="setting-label" id="mode-label">
              Show
            </span>
            <Segmented label="mode-label" options={MODES} value={settings.mediaMode} onChange={(mediaMode) => set({ mediaMode })} />
          </div>

          <div className="setting">
            <div className="setting-line">
              <span className="setting-label" id="rounds-label">
                Rounds
              </span>
              <Stepper label="rounds" value={settings.rounds} min={1} max={100} onChange={(rounds) => set({ rounds })} testid="rounds-value" />
            </div>
            <Chips label="rounds-label" values={withValue(ROUND_CHIPS, settings.rounds)} value={settings.rounds} onPick={(rounds) => set({ rounds })} />
          </div>

          <div className="setting">
            <span className="setting-label" id="timer-label">
              Time to guess
            </span>
            <Chips label="timer-label" values={withValue(TIMERS, settings.timerSeconds)} value={settings.timerSeconds} suffix="s" onPick={(timerSeconds) => set({ timerSeconds })} />
          </div>

          <div className="setting">
            <span className="setting-label" id="break-label">
              Between rounds
            </span>
            <Chips label="break-label" values={withValue(BREAKS, settings.breakSeconds)} value={settings.breakSeconds} suffix="s" onPick={(breakSeconds) => set({ breakSeconds })} />
            {powerups.shop.enabled && settings.rounds > 1 && settings.breakSeconds < SHOP_MIN_BREAK_SECONDS && (
              <p className="setting-note" data-testid="shop-break-note">
                Shop rounds last {SHOP_MIN_BREAK_SECONDS} s
              </p>
            )}
          </div>

          <div className="setting">
            <span className="setting-label" id="swaps-label">
              Swaps
            </span>
            <Chips label="swaps-label" values={withValue(SWAPS, settings.swaps)} value={settings.swaps} onPick={(swaps) => set({ swaps })} />
          </div>

          <div className="setting">
            <div className="setting-line">
              <span className="setting-label with-icon" id="even-label">
                <EvenSplitIcon size={18} />
                Even Split
              </span>
              <Toggle checked={settings.evenSplit} label="Even Split" onChange={(evenSplit) => set({ evenSplit })} testid="even-split" />
            </div>
            <p className="setting-caption">Everyone deals rounds ÷ players. Every photo gets shown.</p>
          </div>
        </Group>

        <Group title="Effects">
          <EffectBlock
            icon={<GreyscaleIcon size={18} />}
            label="Greyscale"
            enabled={effects.greyscale.enabled}
            onToggle={(enabled) => patchEffect('greyscale', { enabled })}
            testid="effect-greyscale"
          >
            <div className="effect-control">
              <span className="effect-label" id="greyscale-trigger-label">Trigger</span>
              <Segmented label="greyscale-trigger-label" options={TRIGGERS} value={effects.greyscale.trigger} onChange={(trigger) => patchEffect('greyscale', { trigger })} />
            </div>
            <div className="effect-control inline">
              <span className="effect-label">After</span>
              <Stepper label="greyscale after" value={effects.greyscale.after} min={2} max={10} onChange={(after) => patchEffect('greyscale', { after })} />
            </div>
          </EffectBlock>

          <EffectBlock
            icon={<BlurIcon size={18} />}
            label="Blur"
            enabled={effects.blur.enabled}
            onToggle={(enabled) => patchEffect('blur', { enabled })}
            testid="effect-blur"
          >
            <div className="effect-control">
              <span className="effect-label" id="blur-trigger-label">Trigger</span>
              <Segmented label="blur-trigger-label" options={TRIGGERS} value={effects.blur.trigger} onChange={(trigger) => patchEffect('blur', { trigger })} />
            </div>
            <div className="effect-control inline">
              <span className="effect-label">After</span>
              <Stepper label="blur after" value={effects.blur.after} min={2} max={10} onChange={(after) => patchEffect('blur', { after })} />
            </div>
            <div className="effect-control">
              <span className="effect-label" id="blur-strength-label">Strength</span>
              <ChoiceChips label="blur-strength-label" options={STRENGTHS} value={effects.blur.strength} onPick={(strength) => patchEffect('blur', { strength })} />
            </div>
          </EffectBlock>

          <EffectBlock
            icon={<FocusIcon size={18} />}
            label="Focus"
            enabled={effects.focus.enabled}
            onToggle={(enabled) => patchEffect('focus', { enabled })}
            testid="effect-focus"
          >
            <div className="effect-control">
              <span className="effect-label" id="focus-frequency-label">When</span>
              <Segmented label="focus-frequency-label" options={FREQUENCIES} value={effects.focus.frequency} onChange={(frequency) => patchEffect('focus', { frequency })} />
            </div>
            <div className="effect-control">
              <span className="effect-label" id="focus-span-label">Span</span>
              <Chips label="focus-span-label" values={SPANS} value={effects.focus.span} suffix="%" onPick={(span) => patchEffect('focus', { span })} />
            </div>
          </EffectBlock>

          <EffectBlock
            icon={<ZoomIcon size={18} />}
            label="Zoom-out"
            enabled={effects.zoom.enabled}
            onToggle={(enabled) => patchEffect('zoom', { enabled })}
            testid="effect-zoom"
          >
            <div className="effect-control">
              <span className="effect-label" id="zoom-frequency-label">When</span>
              <Segmented label="zoom-frequency-label" options={FREQUENCIES} value={effects.zoom.frequency} onChange={(frequency) => patchEffect('zoom', { frequency })} />
            </div>
            <div className="effect-control">
              <span className="effect-label" id="zoom-span-label">Span</span>
              <Chips label="zoom-span-label" values={SPANS} value={effects.zoom.span} suffix="%" onPick={(span) => patchEffect('zoom', { span })} />
            </div>
            <div className="effect-control">
              <span className="effect-label" id="zoom-scale-label">Zoom</span>
              <Chips label="zoom-scale-label" values={SCALES} value={effects.zoom.scale} suffix="×" onPick={(scale) => patchEffect('zoom', { scale })} />
            </div>
          </EffectBlock>
        </Group>

        <Group title="Power-ups">
          <EffectBlock
            icon={<ScissorsIcon size={18} />}
            label="50/50"
            enabled={powerups.fiftyFifty.enabled}
            onToggle={(enabled) => send({ type: 'settings', powerups: { ...powerups, fiftyFifty: { ...powerups.fiftyFifty, enabled } } })}
            testid="powerup-fifty"
          >
            <div className="effect-control inline">
              <span className="effect-label">Earn after</span>
              <Stepper
                label="50/50 streak"
                value={powerups.fiftyFifty.after}
                min={2}
                max={10}

                onChange={(after) => send({ type: 'settings', powerups: { ...powerups, fiftyFifty: { ...powerups.fiftyFifty, after } } })}
              />
            </div>
            <p className="setting-caption">Hold up to 2. Grey out half the wrong picks.</p>
          </EffectBlock>

          <EffectBlock
            icon={<CartIcon size={18} />}
            label="Shop"
            enabled={powerups.shop.enabled}
            onToggle={(enabled) => send({ type: 'settings', powerups: { ...powerups, shop: { enabled } } })}
            testid="powerup-shop"
          >
            <p className="setting-caption">Between rounds, one buy each: {shopLine()}.</p>
          </EffectBlock>
        </Group>
      </div>
    </div>
  );
}

const shopLine = () =>
  `${itemName('doubleDown')} ${DEFAULT_PRICES.doubleDown} · ${itemName('shield')} ${DEFAULT_PRICES.shield} · ${itemName('fiftyFifty')} ${DEFAULT_PRICES.fiftyFifty}`;

const itemName = (item: ShopItem) => (item === 'doubleDown' ? 'Double Down' : item === 'shield' ? 'Shield' : '50/50');

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group" aria-label={title}>
      <h3 className="group-title">{title}</h3>
      {children}
    </section>
  );
}

function EffectBlock({
  icon,
  label,
  enabled,
  onToggle,
  testid,
  children,
}: {
  icon: ReactNode;
  label: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  testid: string;
  children: ReactNode;
}) {
  return (
    <div className={`effect-block${enabled ? ' on' : ''}`} data-testid={testid}>
      <div className="setting-line">
        <span className="setting-label with-icon">
          {icon}
          {label}
        </span>
        <Toggle checked={enabled} label={label} onChange={onToggle} />
      </div>
      {enabled && <div className="effect-controls">{children}</div>}
    </div>
  );
}

function Toggle({ checked, label, onChange, testid }: { checked: boolean; label: string; onChange: (checked: boolean) => void; testid?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      data-testid={testid}
    >
      <span className="toggle-knob" aria-hidden="true" />
    </button>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  suffix = '',
  onChange,
  testid,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
  testid?: string;
}) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <output aria-live="polite" data-testid={testid}>
        {value}
        {suffix && <span className="stepper-suffix">{suffix}</span>}
      </output>
      <button type="button" aria-label={`More ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-labelledby={label} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? 'on' : ''} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Chips<T extends number | string>({
  label,
  values,
  value,
  suffix = '',
  onPick,
}: {
  label: string;
  values: readonly T[];
  value: T;
  suffix?: string;
  onPick: (value: T) => void;
}) {
  return (
    <div className="chips" role="radiogroup" aria-labelledby={label} style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
      {values.map((entry) => (
        <button key={String(entry)} type="button" role="radio" aria-checked={value === entry} className={value === entry ? 'chip on' : 'chip'} onClick={() => onPick(entry)}>
          {entry}
          {suffix}
        </button>
      ))}
    </div>
  );
}

function ChoiceChips<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <div className="chips" role="radiogroup" aria-labelledby={label} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? 'chip on' : 'chip'} onClick={() => onPick(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
