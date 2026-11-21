// "It was Sam's": one list. Every player appears once, with what they picked,
// what they earned and where they moved. No separate guesses and standings.
import { useEffect, useState } from 'react';
import type { ResultRow, RoomView } from '../types';
import { Avatar, playerColor, playerIndex } from '../ui/Avatar';
import { CheckIcon, CrossIcon } from '../ui/Icons';
import { mediaKey, type RoomController } from '../useRoom';

interface Standing {
  playerID: string;
  nickname: string;
  score: number;
  delta: number;
  rank: number;
  movement: number;
}

export function Results({ view, room, isHost }: { view: RoomView; room: RoomController; isHost: boolean }) {
  const result = view.lastResult;
  if (!result) return <p className="caption center-text">Working out the scores…</p>;

  const owner = view.players.find((player) => player.id === result.ownerID);
  const entry = room.media[mediaKey(view.game, result.index)];
  const myRow = result.rows.find((row) => row.playerID === view.you.id);
  const mine = result.ownerID === view.you.id;
  const standings = buildStandings(view, result.rows);
  const total = view.round?.total ?? view.settings.rounds;
  const final = result.index >= total;
  const ownerName = owner?.nickname ?? 'someone who left';
  const ownerColor = owner ? playerColor(playerIndex(view, owner.id)) : undefined;

  return (
    <section className="screen results-screen">
      <p className="sr-only" aria-live="polite">
        It was {ownerName}’s. {mine ? 'It was yours.' : myRow ? (myRow.correct ? `You got it, plus ${myRow.points} points.` : 'You did not get it.') : ''}{' '}
        {standings[0] ? `${standings[0].nickname} leads with ${standings[0].score}.` : ''}
      </p>

      <header className="result-hero">
        <p className="caption">
          Round {result.index} of {total}
        </p>
        <Avatar name={ownerName} colorIndex={owner ? playerIndex(view, owner.id) : 0} size="xl" gold />
        <h1 className="title result-title">
          It was <span style={{ color: ownerColor }}>{ownerName}</span>’s
        </h1>
        <Outcome row={myRow} mine={mine} rows={result.rows} ownerID={result.ownerID} />
        {entry && (
          <div className="result-thumb" aria-hidden="true">
            {entry.kind === 'video' ? <video src={entry.url} muted loop autoPlay playsInline /> : <img src={entry.url} alt="" />}
          </div>
        )}
      </header>

      <ol className="result-list">
        {standings.map((standing) => (
          <ResultRowLine key={standing.playerID} view={view} standing={standing} row={result.rows.find((row) => row.playerID === standing.playerID)} ownerID={result.ownerID} />
        ))}
      </ol>

      <div className="result-foot">
        {isHost ? (
          <button type="button" className="btn primary action-btn" onClick={() => room.send({ type: 'advance' })}>
            Next
          </button>
        ) : (
          <NextIn endsAt={view.phaseEndsAt} serverNow={room.serverNow} final={final} />
        )}
      </div>
    </section>
  );
}

/** "Yours" line for the owner: how many of the others spotted it. */
export function ownerLine(rows: ResultRow[], ownerID: string) {
  const others = rows.filter((row) => row.playerID !== ownerID);
  const spotted = others.filter((row) => row.correct).length;
  if (!others.length || spotted === 0) return 'Yours. Nobody knew 😉';
  if (spotted === others.length) return 'Yours. Everyone knew';
  return `Yours. ${spotted} of ${others.length} knew`;
}

function Outcome({ row, mine, rows, ownerID }: { row: ResultRow | undefined; mine: boolean; rows: ResultRow[]; ownerID: string }) {
  if (mine) return <p className="result-outcome">{ownerLine(rows, ownerID)}</p>;
  if (!row) return <p className="result-outcome">Missed it</p>;
  if (!row.correct) return <p className="result-outcome">Missed it</p>;
  return (
    <p className="result-outcome good">
      +<Points value={row.points} />
      {row.streak >= 2 && <span className="result-streak"> · {row.streak} in a row</span>}
    </p>
  );
}

function ResultRowLine({ view, standing, row, ownerID }: { view: RoomView; standing: Standing; row: ResultRow | undefined; ownerID: string }) {
  const owner = standing.playerID === ownerID;
  const you = standing.playerID === view.you.id;
  const target = row?.targetID ? view.players.find((player) => player.id === row.targetID) : null;
  const targetIndex = target ? playerIndex(view, target.id) : 0;

  return (
    <li className={`result-line${owner ? ' owner' : ''}${you ? ' me' : ''}`}>
      <span className="result-rank">{standing.rank}</span>
      <Avatar name={standing.nickname} colorIndex={playerIndex(view, standing.playerID)} size="md" />
      <span className="result-name">
        {standing.nickname}
        {you && <span className="result-you">You</span>}
      </span>

      <span className="result-pick">
        {owner ? (
          <span className="result-owner-tag">owner</span>
        ) : row?.targetID ? (
          <>
            <Avatar name={target?.nickname ?? '?'} colorIndex={targetIndex} size="xs" />
            <span className={row.correct ? 'good result-tick' : 'bad result-tick'} aria-label={row.correct ? 'Correct' : 'Incorrect'}>
              {row.correct ? <CheckIcon /> : <CrossIcon />}
            </span>
          </>
        ) : (
          <span className="result-none">—</span>
        )}
      </span>

      <span className="result-delta good">{!owner && row && row.points > 0 ? <>+<Points value={row.points} /></> : null}</span>
      <span className="result-total">{standing.score}</span>
      <Movement movement={owner ? 0 : standing.movement} />
    </li>
  );
}

function Movement({ movement }: { movement: number }) {
  if (!movement) return <span className="result-move" aria-hidden="true" />;
  const up = movement > 0;
  return (
    <span className={`result-move ${up ? 'good' : 'bad'}`} aria-label={up ? `Up ${movement}` : `Down ${-movement}`}>
      {up ? '↑' : '↓'}
      {Math.abs(movement)}
    </span>
  );
}

function NextIn({ endsAt, serverNow, final }: { endsAt: number | null; serverNow: () => number; final: boolean }) {
  const [left, setLeft] = useState(() => (endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - serverNow()) / 1000))));
  useEffect(() => {
    if (endsAt === null) return;
    const update = () => setLeft((previous) => {
      const next = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
      return previous === next ? previous : next;
    });
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [endsAt, serverNow]);
  return (
    <p className="caption result-next" aria-live="polite">
      {final ? 'Final scores' : 'Next round'} in {left}
    </p>
  );
}

/** Ranks after this round, compared with ranks before it. */
function buildStandings(view: RoomView, rows: ResultRow[]): Standing[] {
  const scored = new Map(rows.map((row) => [row.playerID, row]));
  const entries = view.players.map((player) => {
    const delta = scored.get(player.id)?.points ?? 0;
    return {
      playerID: player.id,
      nickname: player.nickname,
      score: player.score,
      delta,
      previous: player.score - delta,
    };
  });
  const previousRank = new Map([...entries].sort((a, b) => b.previous - a.previous).map((entry, index) => [entry.playerID, index]));
  return [...entries]
    .sort((a, b) => b.score - a.score || (previousRank.get(a.playerID) ?? 0) - (previousRank.get(b.playerID) ?? 0))
    .map((entry, index) => ({ ...entry, rank: index + 1, movement: (previousRank.get(entry.playerID) ?? index) - index }));
}

/** Counts a number up once, respecting Reduce Motion. */
function Points({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const duration = 600;
    let frame = 0;
    const step = (time: number) => {
      const progress = Math.min(1, (time - start) / duration);
      setShown(Math.round(value * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{shown}</>;
}
