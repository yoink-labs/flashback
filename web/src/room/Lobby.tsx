// The lobby: room code once, the people, your deck, one settings row, and the
// single action that starts the game. No cards, no rules paragraph.
import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { Deck } from '../deck';
import type { ClientMessage, RoomView } from '../types';
import { Avatar } from '../ui/Avatar';
import { CrownIcon, XIcon } from '../ui/Icons';
import { Deck as DeckGrid } from './Deck';
import { Settings } from './Settings';

export function Lobby({
  view,
  deck,
  isHost,
  send,
  onLeave,
}: {
  view: RoomView;
  deck: Deck;
  isHost: boolean;
  send: (message: ClientMessage) => void;
  onLeave: () => void;
}) {
  const me = view.players.find((player) => player.id === view.you.id);
  const ready = Boolean(me?.ready);
  const url = `${location.origin}/join/${view.code}`;
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  const share = async () => {
    if (!navigator.share) return copy();
    try {
      await navigator.share({ title: 'Join my Flashback game', url });
    } catch {}
  };

  return (
    <div className="lobby">
      <div className="lobby-left">
        <button type="button" className="icon-btn lobby-leave" onClick={onLeave} aria-label="Leave room">
          <XIcon />
        </button>

        <div className="lobby-code">
          <button type="button" className="code-hero" onClick={copy} title="Copy the invite link" data-testid="room-code-display">
            {view.code}
          </button>
          <div className="code-actions">
            <button type="button" className="pill-btn" onClick={share}>
              {copied ? 'Link copied' : 'Share invite'}
            </button>
            <button type="button" className="pill-btn" onClick={() => setShowQR((value) => !value)} aria-expanded={showQR}>
              QR
            </button>
          </div>
          {showQR && <QR text={url} />}
        </div>

        <ul className="players-row">
          {view.players.map((player, index) => (
            <li key={player.id} className={`player-chip${player.connected ? '' : ' offline'}`}>
              <span className="avatar-wrap">
                <Avatar name={player.nickname} colorIndex={index} size="lg" ready={player.ready} offline={!player.connected} />
                {player.isHost && (
                  <span className="crown" aria-label="Host">
                    <CrownIcon />
                  </span>
                )}
              </span>
              <span className="player-chip-name">{player.nickname}</span>
            </li>
          ))}
          <li className="player-chip invite-row">
            <button type="button" className="player-add" onClick={share} aria-label="Invite someone">
              +
            </button>
            <span className="player-add-label">Invite</span>
          </li>
        </ul>

        <div className="lobby-settings">
          <Settings settings={view.settings} isHost={isHost} send={send} />
        </div>

        <div className="lobby-bar">
          {view.startBlocker && (
            <p className="blocker" role="status">
              {view.startBlocker}
            </p>
          )}
          {isHost ? (
            <button type="button" className="btn primary action-btn" disabled={Boolean(view.startBlocker)} onClick={() => send({ type: 'start' })}>
              Start game
            </button>
          ) : (
            <button
              type="button"
              className={`btn action-btn ${ready ? 'secondary' : 'primary'}`}
              aria-pressed={ready}
              onClick={() => send({ type: 'ready', ready: !ready })}
            >
              {ready ? 'I’m ready ✓' : 'Ready'}
            </button>
          )}
        </div>
      </div>

      <div className="lobby-deck">
        <DeckGrid deck={deck} mode={view.settings.mediaMode} />
      </div>
    </div>
  );
}

function QR({ text }: { text: string }) {
  const qr = useMemo(() => {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    const count = code.getModuleCount();
    let path = '';
    for (let row = 0; row < count; row++)
      for (let column = 0; column < count; column++) if (code.isDark(row, column)) path += `M${column + 2} ${row + 2}h1v1h-1z`;
    return { size: count + 4, path };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`QR code for ${text}`} shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#0E0D12" />
    </svg>
  );
}
