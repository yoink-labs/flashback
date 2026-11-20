import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { isCode, joinRoom, normalizeCode, roomInfo, savedSession, type RoomInfo } from '../api';
import { EntryForm } from './Entry';

export function JoinScreen() {
  const params = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState(normalizeCode(params.code ?? ''));
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [lookup, setLookup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const existing = isCode(code) ? savedSession(code) : null;

  useEffect(() => {
    setInfo(null);
    setLookup(null);
    if (!isCode(code)) return;
    let active = true;
    roomInfo(code)
      .then((i) => active && setInfo(i))
      .catch((e) => active && setLookup(e.status === 404 ? 'That room does not exist or has closed.' : e.message));
    return () => {
      active = false;
    };
  }, [code]);

  const join = async (nickname: string, signedIn: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await joinRoom(code, nickname, signedIn);
      navigate(`/room/${code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="narrow">
      <EntryForm action="Join room" busy={busy} error={error} onSubmit={join}>
        <h2>Join a game</h2>
        <label>
          Room code
          <input className="code-input" value={code} onChange={(e) => setCode(normalizeCode(e.target.value))} placeholder="ABC234" autoComplete="off" />
        </label>
        {info && (
          <p className="hint">
            Room {info.code} · {info.players}/{info.capacity} players · {info.joinable ? 'open to join' : info.players >= info.capacity ? 'full' : 'game in progress'}
          </p>
        )}
        {lookup && <p className="error">{lookup}</p>}
        {existing && (
          <p className="hint">
            You’re already in this room as <strong>{existing.nickname}</strong>. <Link to={`/room/${code}`}>Rejoin</Link>
          </p>
        )}
      </EntryForm>
    </main>
  );
}
