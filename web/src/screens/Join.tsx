// Join with a code: six boxes, then the room preview and one name field as soon
// as the code is complete. Everything else lives elsewhere.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { isCode, joinRoom, normalizeCode, roomInfo, savedSession, type RoomInfo } from '../api';
import { Avatar } from '../ui/Avatar';
import { CodeInput } from '../ui/CodeInput';
import { TipPill } from '../ui/TipPill';
import { BackIcon } from '../ui/Icons';
import { NameInput, useNickname } from './Entry';
import { modeWord } from '../room/Settings';


export function JoinScreen() {
  const params = useParams();
  const navigate = useNavigate();
  const [code, setCode] = useState(normalizeCode(params.code ?? ''));
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { name, setName, valid, signedIn, remember } = useNickname();
  const existing = isCode(code) ? savedSession(code) : null;

  useEffect(() => {
    setInfo(null);
    setLookup(null);
    if (!isCode(code)) return;
    let active = true;
    setLooking(true);
    roomInfo(code)
      .then((found) => {
        if (!active) return;
        setInfo(found);
      })
      .catch((e) => {
        if (active) setLookup(e.status === 404 ? 'No room with that code' : (e as Error).message);
      })
      .finally(() => active && setLooking(false));
    return () => {
      active = false;
    };
  }, [code]);

  const join = async (event: FormEvent) => {
    event.preventDefault();
    remember();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await joinRoom(code, name.trim(), signedIn);
      navigate(`/room/${code}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen join-screen">
      <header className="screen-head">
        <Link className="icon-btn" to="/" aria-label="Back to start">
          <BackIcon />
        </Link>
        <h1 className="title">Join a game</h1>
        <span className="screen-head-end">
          <TipPill />
        </span>
      </header>

      <div className="join-body">
        <div className="join-code">
          <CodeInput value={code} onChange={setCode} autoFocus disabled={busy} />
          {lookup && (
            <p className="field-error" role="alert">
              {lookup}
            </p>
          )}
          {!lookup && looking && <p className="caption join-hint">Looking…</p>}
        </div>

        {info && <Preview info={info} />}

        {existing && (
          <div className="join-form">
            <p className="caption">You’re in as {existing.nickname}</p>
            <button type="button" className="btn primary action-btn" onClick={() => navigate(`/room/${code}`)}>
              Rejoin
            </button>
          </div>
        )}

        {!existing && info?.joinable && (
          <form className="join-form" onSubmit={join}>
            <NameInput value={name} onChange={setName} invalid={Boolean(name.trim()) && !valid} disabled={busy} />
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn primary action-btn" disabled={!valid || busy} aria-busy={busy}>
              Join
            </button>
          </form>
        )}

        {!existing && info && !info.joinable && (
          <p className="caption join-hint">{info.players >= info.capacity ? 'This room is full' : 'A game is running. Try again when it ends'}</p>
        )}

        {!existing && error && !info?.joinable && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

function Preview({ info }: { info: RoomInfo }) {
  const facts = [
    `${info.players} ${info.players === 1 ? 'player' : 'players'}`,
    info.settings ? modeWord(info.settings.mediaMode) : null,
    info.settings ? `${info.settings.rounds} ${info.settings.rounds === 1 ? 'round' : 'rounds'}` : null,
  ].filter(Boolean);
  return (
    <div className="room-preview-row" aria-live="polite">
      <Avatar name={info.host ?? '?'} colorIndex={0} size="md" />
      <div className="room-preview-text">
        <p className="headline">{info.host ? `${info.host}’s room` : 'Room'}</p>
        <p className="caption">
          {info.phase === 'lobby' ? facts.join(' · ') : info.phase === 'podium' ? 'Finished · waiting for the host' : 'Game in progress'}
        </p>
      </div>
    </div>
  );
}
