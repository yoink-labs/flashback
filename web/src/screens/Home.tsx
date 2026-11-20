import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRoom, isCode, normalizeCode } from '../api';
import { EntryForm } from './Entry';

export function Home() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const create = async (nickname: string, signedIn: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const session = await createRoom(nickname, signedIn);
      navigate(`/room/${session.code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <section className="hero">
        <h1>Whose photo is it?</h1>
        <p>
          Flashback is a free party game. Everyone adds a few photos or short videos, then guesses whose they are. Play on the web or iPhone in the same room.
        </p>
      </section>
      <div className="split">
        <EntryForm action="Create a room" busy={busy} error={error} onSubmit={create}>
          <h2>Host a game</h2>
        </EntryForm>
        <form
          className="card entry"
          onSubmit={(e) => {
            e.preventDefault();
            if (isCode(code)) navigate(`/join/${code}`);
          }}
        >
          <h2>Join a game</h2>
          <label>
            Room code
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              placeholder="ABC234"
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
              data-testid="room-code"
            />
          </label>
          <button className="primary" disabled={!isCode(code)}>
            Next
          </button>
          <p className="hint">Codes are 6 letters and numbers. You can also open a friend’s join link.</p>
        </form>
      </div>
    </main>
  );
}
