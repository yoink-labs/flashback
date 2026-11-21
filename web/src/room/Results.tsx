// "It was Sam's": one list. Every player appears once, with what they picked,
// what they earned and where they moved. No separate guesses and standings.
import { useEffect, useState } from 'react';
import type { ResultRow, RoomView } from '../types';
import { Avatar, playerColor, playerIndex } from '../ui/Avatar';
import { CheckIcon, CrossIcon } from '../ui/Icons';
import { SaveButton } from '../ui/SaveButton';
import { mediaKey, type RoomController } from '../useRoom';
import { clockOf, DrainBar, GameBar, useSecondsLeft, type Clock } from './Timing';
import { usePlayback } from './usePlayback';

interface Standing {
  playerID: string;
  nickname: string;
  score: number;
  delta: number;
  rank: number;
  movement: number;
}

export const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

export function Results({ view, room, isHost }: { view: RoomView; room: RoomController; isHost: boolean }) {
  const result = view.lastResult;
  if (!result) return <p className="caption center-text">Working out the scores…</p>;

  const owner = view.players.find((player) => player.id === result.ownerID);
  const entry = room.media[mediaKey(view.game, result.index)];
  const myRow = result.rows.find((row) => row.playerID === view.you.id);
  const mine = result.ownerID === view.you.id;
  const standings = buildStandings(view, result.rows);
  const me = standings.find((standing) => standing.playerID === view.you.id);
  const total = view.round?.total ?? view.settings.rounds;
  const final = result.index >= total;
  const ownerName = owner?.nickname ?? 'someone who left';
  const ownerColor = owner ? playerColor(playerIndex(view, owner.id)) : undefined;
  const clock = clockOf(view, view.phaseEndsAt, room.serverNow);

  return (
    <section className="screen game-screen results-screen">
      <p className="sr-only" aria-live="polite">
        It was {ownerName}’s. {mine ? 'It was yours.' : myRow ? (myRow.correct ? `You got it, plus ${myRow.points} points.` : 'You did not get it.') : ''}{' '}
        {me ? `You are ${ordinal(me.rank)} of ${standings.length} with ${me.score}.` : ''}
      </p>

      <GameBar view={view} isHost={isHost} send={room.send} label={`Round ${result.index} of ${total}`} />
      <DrainBar clock={clock} totalMs={view.settings.breakSeconds * 1000} className="next-bar" />

      <header className="result-hero">
        <div className="result-media">
          {entry ? (
            entry.kind === 'video' ? <ResultVideo url={entry.url} paused={view.paused} /> : <img src={entry.url} alt="" />
          ) : (
            <span className="result-media-empty" />
          )}
          <SaveButton entry={entry} round={result.index} className="on-media" />
        </div>
        <div className="result-who">
          <Avatar name={ownerName} colorIndex={owner ? playerIndex(view, owner.id) : 0} size="md" gold />
          <h1 className="title result-title">
            It was <span style={{ color: ownerColor }}>{ownerName}</span>’s
          </h1>
          {mine && <p className="caption result-owner-line">{ownerLine(result.rows, result.ownerID)}</p>}
        </div>
      </header>

      {me && <YouCard me={me} row={myRow} mine={mine} players={standings.length} />}

      <ol className="result-list">
        {standings.map((standing) => (
          <ResultRowLine key={standing.playerID} view={view} standing={standing} row={result.rows.find((row) => row.playerID === standing.playerID)} ownerID={result.ownerID} />
        ))}
      </ol>

      <div className="result-foot">
        {isHost ? (
          <button type="button" className="btn primary action-btn" onClick={() => room.send({ type: 'advance' })} disabled={view.paused} data-testid="next">
            {final ? 'Final scores' : 'Next round'}
          </button>
        ) : (
          <NextIn clock={clock} final={final} />
        )}
      </div>
    </section>
  );
}

/** Your rank, this round's points, movement and total, in one line of big numbers. */
function YouCard({ me, row, mine, players }: { me: Standing; row: ResultRow | undefined; mine: boolean; players: number }) {
  const points = !mine && row?.correct ? row.points : 0;
  const move = mine ? 0 : me.movement;
  return (
    <div className="you-card" data-testid="you-card">
      <div className="you-stat">
        <span className="you-value">
          {ordinal(me.rank)}
          <span className="you-of"> of {players}</span>
        </span>
        <span className={`you-label${move > 0 ? ' good' : move < 0 ? ' bad' : ''}`}>
          {move > 0 ? `▲ ${move}` : move < 0 ? `▼ ${-move}` : `Held ${ordinal(me.rank)}`}
        </span>
      </div>
      <div className="you-stat">
        <span className={`you-value${points > 0 ? ' good' : ' muted'}`}>{points > 0 ? <>+<Points value={points} /></> : mine ? 'Yours' : 'No points'}</span>
        <span className="you-label">{row?.streak && row.streak >= 2 && points > 0 ? `This round · ${row.streak} in a row` : 'This round'}</span>
      </div>
      <div className="you-stat">
        <span className="you-value">{me.score.toLocaleString()}</span>
        <span className="you-label">Total</span>
      </div>
    </div>
  );
}

function ResultVideo({ url, paused }: { url: string; paused: boolean }) {
  const video = usePlayback(paused);
  return <video ref={video} src={url} muted loop autoPlay={!paused} playsInline />;
}

/** "Yours" line for the owner: how many of the others spotted it. */
export function ownerLine(rows: ResultRow[], ownerID: string) {
  const others = rows.filter((row) => row.playerID !== ownerID);
  const spotted = others.filter((row) => row.correct).length;
  if (!others.length || spotted === 0) return 'Yours. Nobody knew 😉';
  if (spotted === others.length) return 'Yours. Everyone knew';
  return `Yours. ${spotted} of ${others.length} knew`;
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

function NextIn({ clock, final }: { clock: Clock; final: boolean }) {
  const left = useSecondsLeft(clock);
  return (
    <p className="caption result-next" aria-live="polite">
      {clock.paused ? 'Paused' : `${final ? 'Final scores' : 'Next round'} in ${left}`}
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
