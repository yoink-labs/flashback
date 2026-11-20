// Shared nickname form for creating or joining a room, as a guest or signed in.
import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { displayName, signOut, useClerk } from '../clerk';

export const NICKNAME_MAX = 24;
const visible = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s.trim())].length;

export function nicknameProblem(nickname: string) {
  const n = visible(nickname);
  if (!n) return 'Choose a nickname.';
  if (n > NICKNAME_MAX) return `Nicknames can be up to ${NICKNAME_MAX} characters.`;
  return null;
}

export function EntryForm({ action, busy, error, onSubmit, children }: { action: string; busy: boolean; error: string | null; onSubmit: (nickname: string, signedIn: boolean) => void; children?: React.ReactNode }) {
  const clerk = useClerk();
  const location = useLocation();
  const [nickname, setNickname] = useState('');
  const [asGuest, setAsGuest] = useState(false);
  const [touched, setTouched] = useState(false);
  const signedIn = Boolean(clerk.user) && !asGuest;
  const shown = nickname || (touched ? '' : signedIn ? displayName(clerk.user) : '');
  const problem = nicknameProblem(shown);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!problem) onSubmit(shown.trim(), signedIn);
  };

  return (
    <form className="card entry" onSubmit={submit}>
      {children}
      <label>
        Nickname
        <input
          value={shown}
          onChange={(e) => (setTouched(true), setNickname(e.target.value))}
          placeholder="What should friends call you?"
          autoComplete="nickname"
          maxLength={64}
          aria-invalid={touched && Boolean(problem)}
          data-testid="nickname"
        />
      </label>
      {touched && problem && <p className="error">{problem}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>
        {busy ? 'One moment…' : action}
      </button>
      <div className="identity">
        {clerk.user && !asGuest ? (
          <p>
            Signed in as <strong>{displayName(clerk.user) || 'your Yoink Labs account'}</strong>.{' '}
            <button type="button" className="link" onClick={() => setAsGuest(true)}>
              Play as a guest instead
            </button>{' '}
            ·{' '}
            <button type="button" className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </p>
        ) : (
          <p>
            Playing as a <strong>guest</strong>. No account needed.
            {clerk.status === 'ready' && !clerk.user && (
              <>
                {' '}
                Have a Yoink Labs account? <Link to={`/sign-in?return=${encodeURIComponent(location.pathname)}`}>Sign in</Link>
              </>
            )}
            {clerk.user && asGuest && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => setAsGuest(false)}>
                  Use my account
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </form>
  );
}
