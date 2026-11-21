// What one player is allowed to see. Built fresh per viewer: the owner of an
// open round, slot ids, the schedule, held guesses, and your own private
// effects must never appear in anyone else's view (docs/MILESTONE4.md §2–7).
import { bunchFor } from './bunch';
import { rankFinal } from './scoring';
import { SHOP_PRICES, shopOpenFor } from './shop';
import { CAPACITY, type RoomState } from './state';

/**
 * `startBlocker` is the game's lobby policy, already worded for this viewer
 * (null outside the lobby). Everything else is derived from state.
 */
export function roomView(state: RoomState, viewerID: string, now: number, startBlocker: string | null) {
  const s = state;
  const round = s.round;
  const ranked = s.phase === 'podium' ? rankFinal(s.players) : [];
  const bunch = bunchFor(s.settings.mediaMode, s.settings.evenSplit, s.settings.rounds, s.players.length);
  const shop =
    s.phase === 'results' && s.settings.powerups.shop.enabled
      ? {
          open: shopOpenFor({
            shopEnabled: true,
            phase: s.phase,
            paused: s.pausedAt !== null,
            lastResultIndex: s.lastResult?.index ?? null,
            totalRounds: s.totalRounds,
          }),
          bought: s.shopBought[viewerID] === true,
          prices: { ...SHOP_PRICES },
        }
      : null;
  return {
    code: s.code,
    phase: s.phase,
    game: s.game,
    hostID: s.hostID,
    capacity: CAPACITY,
    settings: s.settings,
    /** How many of each kind every player must deal right now. */
    bunch,
    serverNow: now,
    phaseEndsAt: s.phaseEndsAt,
    paused: s.pausedAt !== null,
    pausedRemainingMs: s.pausedRemainingMs,
    startBlocker,
    players: [...s.players]
      .sort((a, b) => a.joinSeq - b.joinSeq)
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        signedIn: p.kind === 'clerk',
        isHost: p.id === s.hostID,
        ready: p.ready,
        connected: p.connected,
        score: p.score,
        streak: p.streak,
        deck: { photos: p.deck.photos, videos: p.deck.videos },
        items: { doubleDown: p.items.doubleDown, shield: p.items.shield, fiftyFifty: p.items.fiftyFifty },
      })),
    you: { id: viewerID },
    round:
      round && s.phase === 'countdown'
        ? countdownRound(s, round, viewerID)
        : round && s.phase === 'reveal'
          ? {
              index: round.index,
              total: s.totalRounds,
              kind: round.kind,
              revealAt: round.revealAt,
              endsAt: round.endsAt,
              canGuess: round.guessers.includes(viewerID) && !round.guesses[viewerID],
              yourGuess: round.guesses[viewerID]?.targetID ?? null,
              guessedCount: Object.keys(round.guesses).length,
              guesserCount: round.guessers.length,
              /** Shared by every viewer, decided when the reveal began. */
              effect: round.effect,
              /** This viewer's streak effect, or null (the owner never gets one). */
              yourEffect: round.streakEffects[viewerID] ?? null,
              /** Wrong choices this viewer's 50/50 greyed out; empty when unused. */
              eliminated: round.eliminated[viewerID] ?? [],
            }
          : s.phase === 'results' || s.phase === 'podium'
            ? { index: s.lastResult?.index ?? 0, total: s.totalRounds }
            : null,
    lastResult: s.phase === 'results' || s.phase === 'podium' ? s.lastResult : null,
    shop,
    podium: ranked.map((p, i) => ({ playerID: p.id, rank: i + 1, score: p.score, bestStreak: p.bestStreak, correctCount: p.correctCount })),
  };
}

export type RoomView = ReturnType<typeof roomView>;

/**
 * A countdown's round. `waiting` means the reveal time isn't fixed yet (no
 * upload, or someone's media is still arriving); a paused countdown whose
 * upload landed is not "Shuffling…". Once fixed (and not paused) it carries the
 * planned `revealAt` and the round's effects, so every client flips to the
 * reveal at the same server time (docs/MILESTONE5.md §3).
 */
function countdownRound(s: RoomState, round: NonNullable<RoomState['round']>, viewerID: string) {
  const paused = s.pausedAt !== null;
  const uploaded = s.slots.find((slot) => slot.id === round.slotID)?.status === 'ready';
  const fixed = round.planned && !paused && s.phaseEndsAt !== null;
  return {
    index: round.index,
    total: s.totalRounds,
    waiting: !uploaded || (!paused && !round.planned),
    revealAt: fixed ? s.phaseEndsAt : null,
    // Only once fixed: an open round must not say which kind it needs.
    ...(fixed ? { kind: round.kind, effect: round.effect, yourEffect: round.streakEffects[viewerID] ?? null } : {}),
  };
}
