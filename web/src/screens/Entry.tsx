// Shared nickname field for creating or joining a room, as a guest or signed
// in. One input, remembered on this device, prefilled from the account.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { rememberNickname, savedNickname } from '../api';
import { displayName, signOut, useClerk } from '../clerk';

export const NICKNAME_MAX = 24;
const visible = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s.trim())].length;

export function nicknameProblem(nickname: string) {
  const n = visible(nickname);
  if (!n) return 'Choose a nickname.';
  if (n > NICKNAME_MAX) return `Up to ${NICKNAME_MAX} characters.`;
  return null;
}

/** A remembered name, quietly prefilled from the account when there is one. */
export function useNickname() {
  const clerk = useClerk();
  const [typed, setTyped] = useState<string | null>(null);
  const [asGuest, setAsGuest] = useState(false);
  const name = typed ?? (displayName(clerk.user) || savedNickname());
  const problem = nicknameProblem(name);
  return {
    name,
    setName: setTyped,
    problem,
    valid: problem === null,
    signedIn: Boolean(clerk.user) && !asGuest,
    playAsGuest: () => setAsGuest(true),
    useAccount: () => setAsGuest(false),
    remember: () => {
      if (!problem) rememberNickname(name.trim());
    },
  };
}

/** One small text control, top right: sign in, or the account and its two choices. */
export function AccountControl({ signedIn, onGuest, onAccount }: { signedIn: boolean; onGuest: () => void; onAccount: () => void }) {
  const clerk = useClerk();
  const [open, setOpen] = useState(false);
  if (clerk.status !== 'ready') return <span className="account" aria-hidden="true" />;
  if (!clerk.user)
    return (
      <Link className="account" to="/sign-in?return=%2F">
        Sign in
      </Link>
    );
  return (
    <div className="account-wrap">
      <button type="button" className="account" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
        {displayName(clerk.user) || 'Account'}
      </button>
      {open && (
        <div className="account-menu" role="menu">
          {signedIn ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onGuest(); }}>
              Play as a guest instead
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onAccount(); }}>
              Use my account
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function NameInput({
  value,
  onChange,
  autoFocus = false,
  invalid = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  invalid?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      className="name-input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Your name"
      aria-label="Your name"
      aria-invalid={invalid || undefined}
      autoComplete="nickname"
      autoFocus={autoFocus}
      maxLength={64}
      disabled={disabled}
      data-testid="nickname"
    />
  );
}
