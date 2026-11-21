// The front door: a fanned stack of polaroids, the wordmark, one name field,
// and the two ways in. Nothing else.
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom } from '../api';
import { AccountControl, NameInput, useNickname } from './Entry';
import { TIP_URL, TipPill } from '../ui/TipPill';

export function Home() {
  const navigate = useNavigate();
  const { name, setName, problem, valid, signedIn, playAsGuest, useAccount, remember } = useNickname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problemText = name.trim() ? problem : null;

  const host = async (event: FormEvent) => {
    event.preventDefault();
    remember();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createRoom(name.trim(), signedIn);
      navigate(`/room/${session.code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen home-screen">
      <header className="home-top">
        <TipPill />
        <AccountControl signedIn={signedIn} onGuest={playAsGuest} onAccount={useAccount} />
      </header>

      <div className="home-center">
        <div className="polaroids" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1 className="wordmark">Flashback</h1>
        <p className="home-sub">Whose camera roll is it?</p>

        <form className="home-form" onSubmit={host}>
          <NameInput value={name} onChange={setName} invalid={Boolean(problemText)} disabled={busy} />
          {problemText && <p className="field-error">{problemText}</p>}
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn primary action-btn" disabled={!valid || busy} aria-busy={busy}>
            Host a game
          </button>
          <button type="button" className="btn secondary action-btn" onClick={() => navigate('/join')}>
            Join with code
          </button>
        </form>
      </div>

      <p className="home-footer">
        Free · no account · nothing is kept · <a href={TIP_URL}>Tip the devs</a>
      </p>
    </main>
  );
}
