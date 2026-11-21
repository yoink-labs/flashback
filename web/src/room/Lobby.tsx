// The lobby. Phone: one column (code, people, settings, your bunch) with the
// one primary action pinned in the thumb zone. Wide (≥ 900 px): the bunch is
// the canvas on the left, sized to fill the height; the room controls are the
// tools on the right.
import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { kindsFor, type Deck } from '../deck';
import type { ClientMessage, MediaKind, RoomView } from '../types';
import { Avatar } from '../ui/Avatar';
import { CrownIcon, PlusIcon, QRIcon, ShareIcon, XIcon } from '../ui/Icons';
import { toast } from '../ui/Toast';
import { Deck as Bunch } from './Deck';
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
  const [showQR, setShowQR] = useState(false);
  const kinds = kindsFor(view.settings.mediaMode);
  const [chosenStep, setStep] = useState<MediaKind>(() => (deck.photo.full && !deck.video.full ? 'video' : 'photo'));
  const step = kinds.includes(chosenStep) ? chosenStep : kinds[0];
  // Mix: once the photos are dealt, the primary action walks to the videos.
  const nextToVideos = kinds.length === 2 && step === 'photo' && deck.photo.full && !deck.video.full;

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(url);
      toast('Invite link copied');
    } catch {}
  };

  const share = async () => {
    if (!navigator.share || !window.matchMedia?.('(pointer: coarse)').matches) return copy();
    try {
      await navigator.share({ title: 'Join my Flashback game', url });
    } catch {}
  };

  return (
    <div className="lobby">
      <section className="lobby-room" aria-label="Room">
        <div className="lobby-top">
          <button type="button" className="round-btn ghost" onClick={onLeave} aria-label="Leave room" data-testid="leave-room">
            <XIcon />
          </button>
        </div>

        <div className="lobby-code">
          <button type="button" className="code-hero" onClick={copy} aria-label={`Room code ${view.code}. Copy the invite link`} data-testid="room-code-display">
            {view.code}
          </button>
          <div className="code-actions">
            <button type="button" className="pill-btn" onClick={share}>
              <ShareIcon size={18} />
              Share invite
            </button>
            <button type="button" className={`pill-btn${showQR ? ' on' : ''}`} onClick={() => setShowQR((value) => !value)} aria-expanded={showQR}>
              <QRIcon size={18} />
              QR
            </button>
          </div>
          {showQR && <QR text={url} />}
        </div>

        <ul className="players-row" aria-label="Players">
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
              <span className="player-chip-name">{player.id === view.you.id ? 'You' : player.nickname}</span>
            </li>
          ))}
          <li className="player-chip invite-chip">
            <button type="button" className="player-add" onClick={share} aria-label="Invite someone">
              <PlusIcon size={22} />
            </button>
            <span className="player-chip-name">Invite</span>
          </li>
        </ul>

        <Settings settings={view.settings} isHost={isHost} send={send} />
      </section>

      <section className="lobby-bunch">
        <Bunch deck={deck} mode={view.settings.mediaMode} step={step} onStep={setStep} />
      </section>

      <div className="lobby-bar">
        <div className="lobby-bar-inner">
          {nextToVideos ? (
            <>
              <p className="blocker">Photos done. Now your videos</p>
              <button type="button" className="btn primary action-btn" onClick={() => setStep('video')} data-testid="next-videos">
                Next: videos
              </button>
            </>
          ) : (
            <>
              {view.startBlocker && (
                <p className="blocker" role="status">
                  {view.startBlocker}
                </p>
              )}
              {isHost ? (
                <button type="button" className="btn primary action-btn" disabled={Boolean(view.startBlocker)} onClick={() => send({ type: 'start' })} data-testid="start-game">
                  Start game
                </button>
              ) : (
                <button
                  type="button"
                  className={`btn action-btn ${ready ? 'secondary' : 'primary'}`}
                  aria-pressed={ready}
                  disabled={!ready && !deck.fits}
                  onClick={() => send({ type: 'ready', ready: !ready })}
                  data-testid="ready"
                >
                  {ready ? 'I’m ready ✓' : 'Ready'}
                </button>
              )}
            </>
          )}
        </div>
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
