// Six code boxes: auto-advance, paste-friendly, uppercase. No placeholder dots.
import { useEffect, useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { normalizeCode } from '../api';

const LENGTH = 6;

export function CodeInput({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const boxes = Array.from({ length: LENGTH }, (_, index) => value[index] ?? '');

  const focus = (index: number) => refs.current[Math.max(0, Math.min(LENGTH - 1, index))]?.focus();

  useEffect(() => {
    if (autoFocus && !value) refs.current[0]?.focus();
    // Only on mount: refocusing on every change would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const write = (index: number, raw: string) => {
    const clean = normalizeCode(raw);
    if (!clean) {
      // A deletion inside a box shifts the rest left.
      onChange((value.slice(0, index) + value.slice(index + 1)).slice(0, LENGTH));
      return;
    }
    const current = boxes[index];
    // Usually the box was selected and `clean` is the replacement. If the
    // browser appended to the existing character (autofill, IME), keep it and
    // insert what followed.
    const insert = current && clean.startsWith(current) ? clean.slice(current.length) : clean;
    const next = (value.slice(0, index) + (current && insert !== clean ? current : '') + insert + value.slice(index + 1)).slice(0, LENGTH);
    onChange(next);
    focus(index + insert.length);
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !boxes[index]) {
      event.preventDefault();
      onChange(value.slice(0, Math.max(0, value.length - 1)));
      focus(index - 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focus(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focus(index + 1);
    }
  };

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = normalizeCode(event.clipboardData.getData('text'));
    if (!text) return;
    event.preventDefault();
    const next = (value.slice(0, index) + text).slice(0, LENGTH);
    onChange(next);
    focus(index + text.length);
  };

  return (
    <div className="code-boxes" role="group" aria-label="Room code">
      {boxes.map((box, index) => (
        <input
          key={index}
          ref={(element) => {
            refs.current[index] = element;
          }}
          className="code-box"
          value={box}
          disabled={disabled}
          onChange={(event) => write(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={(event) => onPaste(index, event)}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={`Room code character ${index + 1} of ${LENGTH}`}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={LENGTH}
          data-testid={index === 0 ? 'room-code' : undefined}
        />
      ))}
    </div>
  );
}
