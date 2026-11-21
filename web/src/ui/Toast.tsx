// One short message at a time, top centre (clear of the guess buttons). Anything
// can call `toast("Saved")`; the room shell renders the <Toaster />.
import { useEffect, useState } from 'react';

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function toast(message: string) {
  listeners.forEach((listener) => listener(message));
}

export function Toaster() {
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);

  useEffect(() => {
    const listener: Listener = (text) => setMessage({ text, id: Date.now() });
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 2200);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {message && (
        <span key={message.id} className="toast">
          {message.text}
        </span>
      )}
    </div>
  );
}
