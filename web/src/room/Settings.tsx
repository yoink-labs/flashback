// One quiet settings row in the lobby. The host opens a sheet (a bottom sheet
// on phones, a dialog on wide screens) to change everything; everyone else
// just reads the summary.
import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, MediaMode, RoomSettings } from '../types';
import { ChevronIcon, SlidersIcon } from '../ui/Icons';
import { useModal } from '../ui/useModal';

const MODES: { value: MediaMode; label: string }[] = [
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'both', label: 'Mix' },
];

const ROUND_CHIPS = [5, 10, 15, 20];
const TIMERS = [10, 15, 20, 30, 45, 60];
const BREAKS = [3, 5, 7, 10, 15];
const SWAPS = [0, 1, 3, 5];

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
  const sheet = useRef<HTMLDivElement>(null);

  useModal(onClose);
  useEffect(() => sheet.current?.focus(), []);

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

        <div className="setting">
          <span className="setting-label" id="mode-label">
            Show
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="mode-label">
            {MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={settings.mediaMode === mode.value}
                className={settings.mediaMode === mode.value ? 'on' : ''}
                onClick={() => set({ mediaMode: mode.value })}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting">
          <div className="setting-line">
            <span className="setting-label" id="rounds-label">
              Rounds
            </span>
            <div className="stepper" role="group" aria-labelledby="rounds-label">
              <button type="button" aria-label="Fewer rounds" disabled={settings.rounds <= 1} onClick={() => set({ rounds: settings.rounds - 1 })}>
                −
              </button>
              <output aria-live="polite" data-testid="rounds-value">
                {settings.rounds}
              </output>
              <button type="button" aria-label="More rounds" disabled={settings.rounds >= 30} onClick={() => set({ rounds: settings.rounds + 1 })}>
                +
              </button>
            </div>
          </div>
          <Chips label="rounds-label" values={ROUND_CHIPS} value={settings.rounds} onPick={(rounds) => set({ rounds })} />
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
        </div>

        <div className="setting">
          <span className="setting-label" id="swaps-label">
            Swaps
          </span>
          <Chips label="swaps-label" values={withValue(SWAPS, settings.swaps)} value={settings.swaps} onPick={(swaps) => set({ swaps })} />
        </div>
      </div>
    </div>
  );
}

function Chips({ label, values, value, suffix = '', onPick }: { label: string; values: number[]; value: number; suffix?: string; onPick: (value: number) => void }) {
  return (
    <div className="chips" role="radiogroup" aria-labelledby={label} style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
      {values.map((entry) => (
        <button key={entry} type="button" role="radio" aria-checked={value === entry} className={value === entry ? 'chip on' : 'chip'} onClick={() => onPick(entry)}>
          {entry}
          {suffix}
        </button>
      ))}
    </div>
  );
}
