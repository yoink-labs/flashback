import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import qrcode from 'qrcode-generator';
import { fetchMedia, leaveRoom, normalizeCode, savedSession, uploadMedia, type RoomSession } from '../api';
import { isVideoFile, MediaPrepError, preparePhoto, prepareVideo } from '../media';
import type { MediaMode, PlayerView, RoomView } from '../types';
import { useRoom } from '../useRoom';

const ITEMS_PER_PLAYER = 10;

export function RoomScreen() {
  const code = normalizeCode(useParams().code ?? '');
  const session = useMemo(() => savedSession(code), [code]);
  if (!session) return <Navigate to={`/join/${code}`} replace />;
  return <Room session={session} />;
}

function Room({ session }: { session: RoomSession }) {
  const room = useRoom(session);
  const navigate = useNavigate();
  const { view } = room;
  const current = () => ({ ...session, token: room.token.current });

  if (room.connection === 'closed')
    return (
      <main className="narrow">
        <div className="card">
          <h2>{room.closedReason === 'removed' ? 'You left the room' : room.closedReason === 'lost' ? 'Connection lost' : 'This room has closed'}</h2>
          <p>Photos and videos from this room have been deleted.</p>
          <Link className="button primary" to="/">
            Back to start
          </Link>
        </div>
      </main>
    );
  if (!view)
    return (
      <main className="narrow">
        <p className="hint">{room.connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting to the room…'}</p>
      </main>
    );

  const me = view.players.find((p) => p.id === view.you.id);
  const isHost = view.hostID === view.you.id;
  const names = new Map(view.players.map((p) => [p.id, p.nickname]));
  const leave = async () => {
    await leaveRoom(current());
    navigate('/');
  };

  return (
    <main className={`room phase-${view.phase}`}>
      {room.connection !== 'open' && <div className="banner">Reconnecting… your place is saved.</div>}
      {room.error && (
        <div className="banner error" role="alert" onClick={() => room.setError(null)}>
          {room.error}
        </div>
      )}
      {view.phase === 'lobby' && <Lobby view={view} me={me} isHost={isHost} send={room.send} session={current} onLeave={leave} />}
      {view.phase === 'countdown' && <Countdown view={view} serverNow={room.serverNow} />}
      {view.phase === 'reveal' && <Reveal view={view} names={names} send={room.send} session={current} serverNow={room.serverNow} />}
      {view.phase === 'results' && <Results view={view} names={names} isHost={isHost} send={room.send} serverNow={room.serverNow} />}
      {view.phase === 'podium' && <Podium view={view} names={names} isHost={isHost} send={room.send} onLeave={leave} />}
    </main>
  );
}

type Send = ReturnType<typeof useRoom>['send'];

// ---- lobby ----

function QR({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + 2} ${r + 2}h1v1h-1z`;
    return { size: n + 4, path };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${svg.size} ${svg.size}`} role="img" aria-label={`QR code for ${text}`} shapeRendering="crispEdges">
      <rect width={svg.size} height={svg.size} fill="#fff" />
      <path d={svg.path} fill="#000" />
    </svg>
  );
}

function Share({ code }: { code: string }) {
  const url = `${location.origin}/join/${code}`;
  const [copied, setCopied] = useState(false);
  return (
    <section className="card share">
      <p className="label">Room code</p>
      <p className="code" data-testid="room-code-display">
        {code}
      </p>
      <QR text={url} />
      <div className="row">
        <button
          onClick={async () => {
            await navigator.clipboard?.writeText(url).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        {'share' in navigator && <button onClick={() => navigator.share({ title: 'Join my Flashback game', url }).catch(() => {})}>Share…</button>}
      </div>
    </section>
  );
}

function PlayerList({ view }: { view: RoomView }) {
  return (
    <ul className="players">
      {view.players.map((p) => (
        <li key={p.id} className={p.connected ? '' : 'away'}>
          <span className="avatar">{[...p.nickname][0]?.toUpperCase()}</span>
          <span className="name">
            {p.nickname}
            {p.id === view.you.id && <em> (you)</em>}
          </span>
          {p.isHost && <span className="tag">Host</span>}
          {p.signedIn && <span className="tag subtle" title="Signed in with Yoink Labs">✓</span>}
          {!p.connected && <span className="tag subtle">away</span>}
          {view.phase === 'lobby' ? (
            <span className="count">
              {p.photos ? `${p.photos} 📷` : ''} {p.videos ? `${p.videos} 🎬` : ''} {p.ready ? <span className="ready">Ready</span> : <span className="waiting">Not ready</span>}
            </span>
          ) : (
            <span className="score">{p.score}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

const MODES: { value: MediaMode; label: string }[] = [
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' },
  { value: 'both', label: 'Both' },
];

function Settings({ view, isHost, send }: { view: RoomView; isHost: boolean; send: Send }) {
  const s = view.settings;
  return (
    <section className="card settings">
      <h3>Settings {isHost ? '' : <small>(set by the host)</small>}</h3>
      <label>
        Rounds
        <select disabled={!isHost} value={s.rounds} onChange={(e) => send({ type: 'settings', rounds: Number(e.target.value) })}>
          {[3, 5, 8, 10, 15, 20].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label>
        Timer
        <select disabled={!isHost} value={s.timerSeconds} onChange={(e) => send({ type: 'settings', timerSeconds: Number(e.target.value) })}>
          {[10, 15, 20, 30, 45, 60].map((n) => (
            <option key={n} value={n}>
              {n} seconds
            </option>
          ))}
        </select>
      </label>
      <div className="segmented" role="radiogroup" aria-label="Media">
        {MODES.map((m) => (
          <button key={m.value} role="radio" aria-checked={s.mediaMode === m.value} disabled={!isHost} className={s.mediaMode === m.value ? 'on' : ''} onClick={() => send({ type: 'settings', mediaMode: m.value })}>
            {m.label}
          </button>
        ))}
      </div>
    </section>
  );
}

interface Pending {
  name: string;
  status: string;
  error?: boolean;
}

function Uploader({ view, session }: { view: RoomView; session: () => RoomSession }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const mode = view.settings.mediaMode;
  const accept = mode === 'photos' ? 'image/*' : mode === 'videos' ? 'video/*' : 'image/*,video/*';
  const slots = ITEMS_PER_PLAYER - view.you.items.length;

  const handle = async (files: File[]) => {
    const chosen = files.slice(0, slots);
    const list: Pending[] = chosen.map((f) => ({ name: f.name, status: 'Waiting…' }));
    if (files.length > slots) list.push({ name: `${files.length - slots} more`, status: `Skipped: up to ${ITEMS_PER_PLAYER} per game`, error: true });
    setPending(list);
    const update = (i: number, patch: Partial<Pending>) => setPending((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    for (const [i, file] of chosen.entries()) {
      const video = isVideoFile(file);
      try {
        if (video && mode === 'photos') throw new MediaPrepError('The host chose Photos only.');
        if (!video && mode === 'videos') throw new MediaPrepError('The host chose Videos only.');
        update(i, { status: video ? 'Making a short clip…' : 'Compressing…' });
        const blob = video ? await prepareVideo(file, (f) => update(i, { status: `Making a short clip… ${Math.round(f * 100)}%` })) : await preparePhoto(file);
        update(i, { status: 'Uploading…' });
        await uploadMedia(session(), blob, video ? 'video/mp4' : 'image/jpeg');
        update(i, { status: 'Added' });
      } catch (e) {
        update(i, { status: (e as Error).message, error: true });
      }
    }
    setTimeout(() => setPending((prev) => prev.filter((p) => p.error)), 2500);
  };

  return (
    <section className="card uploader">
      <h3>Your photos and videos</h3>
      <p className="hint">
        Add 1–{ITEMS_PER_PLAYER}. Photos are shrunk and stripped of location data; videos become a 6-second clip. Only the round being played is ever shown, and
        everything is deleted when it’s done.
      </p>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple
        hidden
        data-testid="media-input"
        onChange={(e) => {
          void handle([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <button className="primary" disabled={slots <= 0} onClick={() => input.current?.click()}>
        {mode === 'photos' ? 'Add photos' : mode === 'videos' ? 'Add videos' : 'Add photos or videos'}
      </button>
      <ul className="items">
        {view.you.items.map((item, i) => (
          <li key={item.id}>
            {item.kind === 'photo' ? '📷' : '🎬'} {item.kind === 'photo' ? 'Photo' : `Clip · ${Math.round((item.durationMs ?? 0) / 1000)}s`} {i + 1}
          </li>
        ))}
        {pending.map((p, i) => (
          <li key={`p${i}`} className={p.error ? 'error' : 'hint'}>
            {p.name}: {p.status}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Lobby({ view, me, isHost, send, session, onLeave }: { view: RoomView; me?: PlayerView; isHost: boolean; send: Send; session: () => RoomSession; onLeave: () => void }) {
  const removable = view.you.items;
  return (
    <div className="lobby">
      <Share code={view.code} />
      <section className="card">
        <h3>
          Players <small>{view.players.length}/{view.capacity}</small>
        </h3>
        <PlayerList view={view} />
        <p className="rule">Everyone adds at least one photo or video and readies up. The host starts when all players are ready (2 or more).</p>
        <div className="row">
          <button className={me?.ready ? '' : 'primary'} onClick={() => send({ type: 'ready', ready: !me?.ready })}>
            {me?.ready ? 'Not ready' : 'I’m ready'}
          </button>
          {isHost && (
            <button className="primary" disabled={Boolean(view.startBlocker)} onClick={() => send({ type: 'start' })}>
              Start game
            </button>
          )}
        </div>
        {view.startBlocker && <p className="hint">{view.startBlocker}</p>}
      </section>
      <Settings view={view} isHost={isHost} send={send} />
      <Uploader view={view} session={session} />
      {removable.length > 0 && (
        <details className="card">
          <summary>Remove an item</summary>
          <ul className="items">
            {removable.map((item, i) => (
              <li key={item.id}>
                {item.kind === 'photo' ? 'Photo' : 'Clip'} {i + 1}{' '}
                <button className="link" onClick={() => send({ type: 'removeItem', itemID: item.id })}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <button className="link danger" onClick={onLeave}>
        Leave room
      </button>
    </div>
  );
}

// ---- game ----

function useNow(serverNow: () => number) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 100);
    return () => clearInterval(t);
  }, [serverNow]);
  return now;
}

function Countdown({ view, serverNow }: { view: RoomView; serverNow: () => number }) {
  const now = useNow(serverNow);
  const left = Math.max(1, Math.ceil(((view.phaseEndsAt ?? now) - now) / 1000));
  return (
    <section className="center">
      <p className="label">
        Round {view.round?.index} of {view.round?.total}
      </p>
      <p className="countdown" aria-live="polite">
        {left}
      </p>
      <p className="hint">Get ready to guess…</p>
    </section>
  );
}

function MediaView({ path, kind, session }: { path: string; kind: 'photo' | 'video'; session: () => RoomSession }) {
  const [url, setURL] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [muted, setMuted] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let objectURL: string | null = null;
    fetchMedia(session(), path, controller.signal)
      .then((blob) => {
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      })
      .catch(() => !controller.signal.aborted && setFailed(true));
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  if (failed) return <div className="media placeholder">Couldn’t load this one.</div>;
  if (!url) return <div className="media placeholder">Loading…</div>;
  if (kind === 'photo') return <img className="media" src={url} alt="Whose photo is this?" />;
  return (
    <div className="media-wrap">
      {/* Starts muted so browsers allow autoplay. */}
      <video className="media" src={url} autoPlay loop muted={muted} playsInline />
      <button className="mute" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
        {muted ? '🔇 Tap for sound' : '🔊 Mute'}
      </button>
    </div>
  );
}

function Reveal({ view, names, send, session, serverNow }: { view: RoomView; names: Map<string, string>; send: Send; session: () => RoomSession; serverNow: () => number }) {
  const round = view.round!;
  const now = useNow(serverNow);
  const total = (round.endsAt ?? 0) - (round.revealAt ?? 0);
  const left = Math.max(0, (round.endsAt ?? now) - now);
  const choices = view.players.filter((p) => p.id !== view.you.id);
  return (
    <div className="reveal">
      <div className="stage">
        <p className="label">
          Round {round.index} of {round.total}
        </p>
        <MediaView path={round.mediaPath!} kind={round.kind!} session={session} />
        <div className="timer" style={{ ['--left' as string]: total ? left / total : 0 }}>
          <span>{Math.ceil(left / 1000)}s</span>
        </div>
      </div>
      <section className="guess card">
        {round.isYours ? (
          <>
            <h3>This one’s yours 🤫</h3>
            <p className="hint">Keep a straight face while the others guess.</p>
          </>
        ) : round.canGuess ? (
          <>
            <h3>{round.yourGuess ? `You guessed ${names.get(round.yourGuess)}` : 'Whose is it?'}</h3>
            <div className="choices">
              {choices.map((p) => (
                <button key={p.id} disabled={Boolean(round.yourGuess)} className={round.yourGuess === p.id ? 'picked' : ''} onClick={() => send({ type: 'guess', targetID: p.id })}>
                  {p.nickname}
                </button>
              ))}
            </div>
          </>
        ) : (
          <h3>Watching this round</h3>
        )}
        <p className="hint">
          {round.guessedCount}/{round.guesserCount} guessed
        </p>
      </section>
    </div>
  );
}

function Results({ view, names, isHost, send, serverNow }: { view: RoomView; names: Map<string, string>; isHost: boolean; send: Send; serverNow: () => number }) {
  const result = view.lastResult!;
  const now = useNow(serverNow);
  const me = result.rows.find((r) => r.playerID === view.you.id);
  return (
    <section className="results card">
      <p className="label">
        Round {result.index} of {view.round?.total}
      </p>
      <h2>
        It was <span className="owner">{names.get(result.ownerID) ?? 'someone who left'}</span>’s {result.kind}!
      </h2>
      {me && <p className={me.correct ? 'good' : 'bad'}>{me.correct ? `Nice! +${me.points}` : 'Not this time.'}</p>}
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Guess</th>
            <th>Points</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.playerID} className={r.correct ? 'good' : ''}>
              <td>{names.get(r.playerID)}</td>
              <td>{r.targetID ? names.get(r.targetID) ?? '—' : 'No guess'}</td>
              <td>
                +{r.points}
                {r.streakBonus > 0 && <small> 🔥{r.streak}</small>}
              </td>
              <td>{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Next round in {Math.max(0, Math.ceil(((view.phaseEndsAt ?? now) - now) / 1000))}s</p>
      {isHost && (
        <div className="row">
          <button className="primary" onClick={() => send({ type: 'advance' })}>
            Next
          </button>
          <button onClick={() => send({ type: 'end' })}>End game</button>
        </div>
      )}
    </section>
  );
}

function Podium({ view, names, isHost, send, onLeave }: { view: RoomView; names: Map<string, string>; isHost: boolean; send: Send; onLeave: () => void }) {
  const medals = ['🥇', '🥈', '🥉'];
  return (
    <section className="podium card">
      <h2>Final scores</h2>
      <ol>
        {view.podium.map((p) => (
          <li key={p.playerID} className={p.rank <= 3 ? `top top${p.rank}` : ''}>
            <span className="medal">{medals[p.rank - 1] ?? `#${p.rank}`}</span>
            <span className="name">{names.get(p.playerID)}</span>
            <span className="score">{p.score}</span>
            <small>
              {p.correctCount} right · best streak {p.bestStreak}
            </small>
          </li>
        ))}
      </ol>
      <p className="hint">All photos and videos from this game have been deleted.</p>
      <div className="row">
        {isHost ? (
          <button className="primary" onClick={() => send({ type: 'playAgain' })}>
            Play again
          </button>
        ) : (
          <p className="hint">Waiting for the host to start another game…</p>
        )}
        <button className="link danger" onClick={onLeave}>
          Leave room
        </button>
      </div>
    </section>
  );
}
