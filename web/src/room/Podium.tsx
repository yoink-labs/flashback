// The final screen: podium order 2 – 1 – 3 with the winner centred and tallest,
// the rest of the field as compact rows, and the host's way back in.
import { useMemo } from 'react';
import type { ClientMessage, PodiumRow, RoomView } from '../types';
import { Avatar, PLAYER_COLORS, playerIndex } from '../ui/Avatar';

export function Podium({
  view,
  isHost,
  send,
  onLeave,
}: {
  view: RoomView;
  isHost: boolean;
  send: (message: ClientMessage) => void;
  onLeave: () => void;
}) {
  const ranked = view.podium?.length ? view.podium : fallbackRanking(view);
  const top = ranked.slice(0, 3);
  // Always three slots so the winner stays in the centre column, even with two players.
  const podiumOrder: Array<PodiumRow | null> = [top[1] ?? null, top[0] ?? null, top[2] ?? null];
  const me = ranked.find((row) => row.playerID === view.you.id);
  const winner = ranked[0];
  const winnerName = view.players.find((player) => player.id === winner?.playerID)?.nickname ?? 'Someone';

  return (
    <section className="screen podium-screen">
      <Confetti />
      <div className="podium-body">
        <h1 className="title podium-title">{me?.rank === 1 ? 'You win!' : `${winnerName} wins!`}</h1>

        <div className="podium-stage">
          {podiumOrder.map((row) => {
            // Only places that exist, so two players sit centred (2 – 1).
            if (!row) return null;
            const player = view.players.find((candidate) => candidate.id === row.playerID);
            const name = player?.nickname ?? 'Someone';
            const champion = row.rank === 1;
            return (
              <div key={row.playerID} className={`podium-col rank-${row.rank}`}>
                <Avatar name={name} colorIndex={playerIndex(view, row.playerID)} size={champion ? 'xl' : 'lg'} gold={champion} />
                <p className="podium-name">{name}</p>
                <p className="podium-score">{row.score}</p>
                <div className="podium-block" aria-hidden="true">
                  <span>{row.rank}</span>
                </div>
              </div>
            );
          })}
        </div>

        {ranked.length > 3 && (
          <ol className="podium-rest">
            {ranked.slice(3).map((row) => {
              const player = view.players.find((candidate) => candidate.id === row.playerID);
              const name = player?.nickname ?? 'Someone';
              return (
                <li key={row.playerID} className={row.playerID === view.you.id ? 'me' : ''}>
                  <span className="podium-rest-rank">{row.rank}</span>
                  <Avatar name={name} colorIndex={playerIndex(view, row.playerID)} size="sm" />
                  <span className="podium-rest-name">{name}</span>
                  <span className="podium-rest-score">{row.score}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="podium-actions">
        {isHost ? (
          <button type="button" className="btn primary action-btn" onClick={() => send({ type: 'playAgain' })}>
            Play again
          </button>
        ) : (
          <p className="caption">The host can start another game</p>
        )}
        <button type="button" className="btn text" onClick={onLeave}>
          Leave
        </button>
      </div>
    </section>
  );
}

/** A short burst of colour, once. Nothing loops. */
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 24 }, (_, index) => ({
        left: `${(index * 4.3 + Math.random() * 4) % 100}%`,
        delay: `${Math.random() * 0.5}s`,
        duration: `${1.8 + Math.random() * 0.9}s`,
        color: PLAYER_COLORS[index % PLAYER_COLORS.length],
        tilt: `${Math.random() * 360}deg`,
        size: 6 + Math.round(Math.random() * 6),
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((piece, index) => (
        <span
          key={index}
          style={{
            left: piece.left,
            animationDelay: piece.delay,
            animationDuration: piece.duration,
            background: piece.color,
            width: piece.size,
            height: piece.size * 0.55,
            rotate: piece.tilt,
          }}
        />
      ))}
    </div>
  );
}

function fallbackRanking(view: RoomView): PodiumRow[] {
  return [...view.players]
    .sort((a, b) => b.score - a.score)
    .map((player, index) => ({ playerID: player.id, rank: index + 1, score: player.score, bestStreak: player.streak, correctCount: 0 }));
}
