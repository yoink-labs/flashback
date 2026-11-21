// One quiet settings row in the lobby. The host opens a sheet to change the
// mode, rounds and timer; everyone else just reads it.
import { useEffect, useState } from 'react';
import type { ClientMessage, MediaMode, RoomSettings } from '../types';

const MODES: { value: MediaMode; label: string }[] = [
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'both', label: 'Mix' },
];

const TIMERS = [10, 20, 30, 45, 60];

const modeWord = (mode: MediaMode) => MODES.find((entry) => entry.value === mode)?.label ?? 'Mix';

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
  const summary = `${modeWord(settings.mediaMode)} · ${settings.rounds} ${settings.rounds === 1 ? 'round' : 'rounds'} · ${settings.timerSeconds}s`;
  const timers = TIMERS.includes(settings.timerSeconds) ? TIMERS : [...TIMERS, settings.timerSeconds].sort((a, b) => a - b);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!isHost) {
    return (
      <div className="settings-row static">
        <span>{summary}</span>
      </div>
    );
  }

  return (
    <>
      <button type="button" className="settings-row" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="settings-row">
        <span>{summary}</span>
        <Chevron />
      </button>

      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-head">
              <h2 id="settings-title" className="headline">
                Game settings
              </h2>
              <button type="button" className="sheet-done" onClick={() => setOpen(false)}>
                Done
              </button>
            </div>

            <div className="setting-row">
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
                    onClick={() => send({ type: 'settings', mediaMode: mode.value })}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <span className="setting-label" id="rounds-label">
                Rounds
              </span>
              <div className="stepper" role="group" aria-labelledby="rounds-label">
                <button type="button" aria-label="Fewer rounds" disabled={settings.rounds <= 1} onClick={() => send({ type: 'settings', rounds: settings.rounds - 1 })}>
                  −
                </button>
                <output aria-live="polite">{settings.rounds}</output>
                <button type="button" aria-label="More rounds" disabled={settings.rounds >= 30} onClick={() => send({ type: 'settings', rounds: settings.rounds + 1 })}>
                  +
                </button>
              </div>
            </div>

            <div className="setting-block">
              <span className="setting-label" id="timer-label">
                Timer
              </span>
              <div className="chips" role="radiogroup" aria-labelledby="timer-label">
                {timers.map((seconds) => (
                  <button
                    key={seconds}
                    type="button"
                    role="radio"
                    aria-checked={settings.timerSeconds === seconds}
                    className={settings.timerSeconds === seconds ? 'chip on' : 'chip'}
                    onClick={() => send({ type: 'settings', timerSeconds: seconds })}
                  >
                    {seconds}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
