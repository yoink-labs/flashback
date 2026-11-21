// The Flashback room protocol (docs/MILESTONE2.md–MILESTONE4.md), shared by the
// socket, the screens, and the deck. The server decides everything that matters;
// the client only ever sees what it is allowed to see.
//
// Every Milestone 4 field is decoded defensively: an older server simply omits
// it, and the normalizers below fill in the contract's defaults.

export type Phase = 'lobby' | 'countdown' | 'reveal' | 'results' | 'podium' | 'closed';
export type MediaMode = 'photos' | 'videos' | 'both';
export type MediaKind = 'photo' | 'video';

export interface DeckCounts {
  photos: number;
  videos: number;
}

// ---- settings (docs/MILESTONE4.md §1) ----

export type EffectTrigger = 'right' | 'wrong';
export type BlurStrength = 'light' | 'medium' | 'heavy';
export type EffectFrequency = 'every' | 'half';
export type EffectSpan = 25 | 50 | 75 | 100;

export interface StreakEffectSettings {
  enabled: boolean;
  trigger: EffectTrigger;
  /** 2–10: the streak length that turns the effect on. */
  after: number;
}

export interface BlurEffectSettings extends StreakEffectSettings {
  strength: BlurStrength;
}

export interface FocusEffectSettings {
  enabled: boolean;
  frequency: EffectFrequency;
  span: EffectSpan;
}

export interface ZoomEffectSettings extends FocusEffectSettings {
  scale: 2 | 3 | 4;
}

export interface RoomEffects {
  greyscale: StreakEffectSettings;
  blur: BlurEffectSettings;
  focus: FocusEffectSettings;
  zoom: ZoomEffectSettings;
}

export interface FiftyFiftySettings {
  enabled: boolean;
  /** Earn one charge whenever a correct guess makes the streak a multiple of this (2–10). */
  after: number;
}

export interface Powerups {
  fiftyFifty: FiftyFiftySettings;
  shop: { enabled: boolean };
}

export interface RoomSettings {
  rounds: number;
  timerSeconds: number;
  mediaMode: MediaMode;
  /** Length of the results screen between rounds (3–30). */
  breakSeconds: number;
  /** Swaps each player gets per bunch (0–10). */
  swaps: number;
  /** Everyone deals rounds ÷ players, so every photo gets shown. */
  evenSplit: boolean;
  effects: RoomEffects;
  powerups: Powerups;
}

export const DEFAULT_EFFECTS: RoomEffects = {
  greyscale: { enabled: false, trigger: 'right', after: 3 },
  blur: { enabled: false, trigger: 'right', after: 5, strength: 'medium' },
  focus: { enabled: false, frequency: 'every', span: 50 },
  zoom: { enabled: false, frequency: 'every', span: 50, scale: 4 },
};

export const DEFAULT_POWERUPS: Powerups = { fiftyFifty: { enabled: false, after: 3 }, shop: { enabled: false } };

export const DEFAULT_SETTINGS: RoomSettings = {
  rounds: 10,
  timerSeconds: 20,
  mediaMode: 'both',
  breakSeconds: 7,
  swaps: 3,
  evenSplit: false,
  effects: DEFAULT_EFFECTS,
  powerups: DEFAULT_POWERUPS,
};

/** The shop's break is never shorter than this when it is enabled (§6). */
export const SHOP_MIN_BREAK_SECONDS = 12;

export type ShopItem = 'doubleDown' | 'shield' | 'fiftyFifty';
export const SHOP_ITEMS: readonly ShopItem[] = ['doubleDown', 'shield', 'fiftyFifty'];
export const DEFAULT_PRICES: Record<ShopItem, number> = { doubleDown: 250, shield: 200, fiftyFifty: 400 };

// ---- views ----

export interface PlayerItems {
  doubleDown: 0 | 1;
  shield: 0 | 1;
  fiftyFifty: 0 | 1 | 2;
}

export const NO_ITEMS: PlayerItems = { doubleDown: 0, shield: 0, fiftyFifty: 0 };

export interface PlayerView {
  id: string;
  nickname: string;
  signedIn: boolean;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  score: number;
  streak: number;
  /** How many deck items this player can still be asked for, by kind. */
  deck?: DeckCounts;
  /** Public power-ups held by this player (docs/MILESTONE4.md §6). */
  items?: PlayerItems;
}

/** What the room needs each player's bunches to hold (docs/MILESTONE4.md §2). */
export interface BunchRequirement {
  photos: number;
  videos: number;
}

export const STANDARD_BUNCH: BunchRequirement = { photos: 12, videos: 6 };

/** The M3 bunch sizes for a mode, used when an older server sends no `bunch`. */
export function bunchForMode(mode: MediaMode): BunchRequirement {
  return { photos: mode === 'videos' ? 0 : STANDARD_BUNCH.photos, videos: mode === 'photos' ? 0 : STANDARD_BUNCH.videos };
}

/** A streak effect the viewer alone sees on the reveal (docs/MILESTONE4.md §3). */
export interface StreakEffect {
  kind: 'greyscale' | 'blur';
  strength?: BlurStrength;
  trigger: EffectTrigger;
  streak: number;
}

/** A round effect everyone sees on the reveal (docs/MILESTONE4.md §4). */
export interface RoundEffect {
  kind: 'focus' | 'zoom';
  spanMs: number;
  scale?: 2 | 3 | 4;
  originX?: number;
  originY?: number;
}

/**
 * During `countdown` only `index`, `total`, and `waiting` are meaningful.
 * During `reveal` the guess fields are present. Nothing here identifies the
 * owner — the owner is revealed in `lastResult` only.
 */
export interface RoundView {
  index: number;
  total: number;
  waiting?: boolean;
  kind?: MediaKind;
  revealAt?: number;
  endsAt?: number;
  canGuess?: boolean;
  yourGuess?: string | null;
  guessedCount?: number;
  guesserCount?: number;
  /** Viewer only: the streak effect on this round's media. Absent from older servers. */
  yourEffect?: StreakEffect | null;
  /** Everyone: the round effect on this round's media. */
  effect?: RoundEffect | null;
  /** Viewer only: players greyed out by a 50/50 (empty when unused). */
  eliminated?: string[];
}

export type DoubleDownResult = 'won' | 'lost' | 'refunded';

export interface ResultRow {
  playerID: string;
  targetID: string | null;
  correct: boolean;
  /** The signed delta actually applied to the score. */
  points: number;
  accuracy: number;
  speed: number;
  streakBonus: number;
  streak: number;
  elapsedMs: number | null;
  total: number;
  // Milestone 4 (optional so older servers decode cleanly):
  /** Sharp eyes bonus folded into `points` (§4). */
  bonus?: number;
  doubleDown?: DoubleDownResult | null;
  shielded?: boolean;
  effect?: 'greyscale' | 'blur' | null;
  roundEffect?: 'focus' | 'zoom' | null;
  fiftyFifty?: boolean;
  earnedFiftyFifty?: boolean;
}

export interface RoundResult {
  index: number;
  ownerID: string;
  kind: MediaKind;
  rows: ResultRow[];
}

export interface PodiumRow {
  playerID: string;
  rank: number;
  score: number;
  bestStreak: number;
  correctCount: number;
}

/** The shop's view during results (docs/MILESTONE4.md §6). */
export interface ShopView {
  open: boolean;
  /** The viewer already bought something this break. */
  bought: boolean;
  prices: Record<ShopItem, number>;
}

export function normalizeShop(raw: unknown): ShopView | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ShopView>;
  const prices = (value.prices ?? {}) as Partial<Record<ShopItem, number>>;
  const price = (item: ShopItem) => {
    const given = prices[item];
    return typeof given === 'number' && Number.isFinite(given) ? Math.max(0, Math.round(given)) : DEFAULT_PRICES[item];
  };
  return {
    open: value.open === true,
    bought: value.bought === true,
    prices: { doubleDown: price('doubleDown'), shield: price('shield'), fiftyFifty: price('fiftyFifty') },
  };
}

// ---- normalizers (older servers omit the new fields) ----

const intIn = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

const boolOr = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

const oneOf = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

const objectOf = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

const TRIGGERS = ['right', 'wrong'] as const;
const STRENGTHS = ['light', 'medium', 'heavy'] as const;
const FREQUENCIES = ['every', 'half'] as const;
const SPANS = [25, 50, 75, 100] as const;
const SCALES = [2, 3, 4] as const;

function normalizeStreakSettings(raw: unknown, fallback: StreakEffectSettings): StreakEffectSettings {
  const value = objectOf(raw);
  return {
    enabled: boolOr(value.enabled, fallback.enabled),
    trigger: oneOf(value.trigger, TRIGGERS, fallback.trigger),
    after: intIn(value.after, 2, 10, fallback.after),
  };
}

export function normalizeEffects(raw: unknown): RoomEffects {
  const value = objectOf(raw);
  const blur = objectOf(value.blur);
  const focus = objectOf(value.focus);
  const zoom = objectOf(value.zoom);
  return {
    greyscale: normalizeStreakSettings(value.greyscale, DEFAULT_EFFECTS.greyscale),
    blur: {
      ...normalizeStreakSettings(blur, DEFAULT_EFFECTS.blur),
      strength: oneOf(blur.strength, STRENGTHS, DEFAULT_EFFECTS.blur.strength),
    },
    focus: {
      enabled: boolOr(focus.enabled, DEFAULT_EFFECTS.focus.enabled),
      frequency: oneOf(focus.frequency, FREQUENCIES, DEFAULT_EFFECTS.focus.frequency),
      span: oneOf(focus.span, SPANS, DEFAULT_EFFECTS.focus.span),
    },
    zoom: {
      enabled: boolOr(zoom.enabled, DEFAULT_EFFECTS.zoom.enabled),
      frequency: oneOf(zoom.frequency, FREQUENCIES, DEFAULT_EFFECTS.zoom.frequency),
      span: oneOf(zoom.span, SPANS, DEFAULT_EFFECTS.zoom.span),
      scale: oneOf(zoom.scale, SCALES, DEFAULT_EFFECTS.zoom.scale),
    },
  };
}

export function normalizePowerups(raw: unknown): Powerups {
  const value = objectOf(raw);
  const fifty = objectOf(value.fiftyFifty);
  const shop = objectOf(value.shop);
  return {
    fiftyFifty: {
      enabled: boolOr(fifty.enabled, DEFAULT_POWERUPS.fiftyFifty.enabled),
      after: intIn(fifty.after, 2, 10, DEFAULT_POWERUPS.fiftyFifty.after),
    },
    shop: { enabled: boolOr(shop.enabled, DEFAULT_POWERUPS.shop.enabled) },
  };
}

/** Settings from any server (older ones lack `breakSeconds`, `swaps`, `evenSplit`, `effects`, `powerups`). */
export function normalizeSettings(raw: Partial<RoomSettings> | null | undefined): RoomSettings {
  const s = objectOf(raw) as Partial<RoomSettings>;
  return {
    rounds: intIn(s.rounds, 1, 100, DEFAULT_SETTINGS.rounds),
    timerSeconds: intIn(s.timerSeconds, 10, 60, DEFAULT_SETTINGS.timerSeconds),
    mediaMode: oneOf(s.mediaMode, ['photos', 'videos', 'both'] as const, DEFAULT_SETTINGS.mediaMode),
    breakSeconds: intIn(s.breakSeconds, 3, 30, DEFAULT_SETTINGS.breakSeconds),
    swaps: intIn(s.swaps, 0, 10, DEFAULT_SETTINGS.swaps),
    evenSplit: boolOr(s.evenSplit, DEFAULT_SETTINGS.evenSplit),
    effects: normalizeEffects(s.effects),
    powerups: normalizePowerups(s.powerups),
  };
}

/** The room's bunch requirement; older servers only know the standard sizes. */
export function normalizeBunch(raw: unknown, mode: MediaMode): BunchRequirement {
  const value = objectOf(raw);
  if (typeof value.photos !== 'number' && typeof value.videos !== 'number') return bunchForMode(mode);
  const fallback = bunchForMode(mode);
  return {
    photos: intIn(value.photos, 0, 100, fallback.photos),
    videos: intIn(value.videos, 0, 100, fallback.videos),
  };
}

export function normalizeItems(raw: unknown): PlayerItems {
  const value = objectOf(raw);
  return {
    doubleDown: intIn(value.doubleDown, 0, 1, 0) as PlayerItems['doubleDown'],
    shield: intIn(value.shield, 0, 1, 0) as PlayerItems['shield'],
    fiftyFifty: intIn(value.fiftyFifty, 0, 2, 0) as PlayerItems['fiftyFifty'],
  };
}

function normalizeStreakEffect(raw: unknown): StreakEffect | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'greyscale' && value.kind !== 'blur') return null;
  return {
    kind: value.kind,
    ...(value.kind === 'blur' ? { strength: oneOf(value.strength, STRENGTHS, 'medium') } : {}),
    trigger: oneOf(value.trigger, TRIGGERS, 'right'),
    streak: intIn(value.streak, 0, 999, 0),
  };
}

function normalizeRoundEffect(raw: unknown): RoundEffect | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'focus' && value.kind !== 'zoom') return null;
  const spanMs = typeof value.spanMs === 'number' && Number.isFinite(value.spanMs) ? Math.max(0, value.spanMs) : 0;
  if (!spanMs) return null;
  return {
    kind: value.kind,
    spanMs,
    ...(value.kind === 'zoom'
      ? {
          scale: oneOf(value.scale, SCALES, 4),
          originX: clamp01(value.originX, 0.5),
          originY: clamp01(value.originY, 0.5),
        }
      : {}),
  };
}

const clamp01 = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

function normalizeRound(raw: RoundView | null | undefined): RoundView | null {
  if (!raw) return null;
  return {
    ...raw,
    // M5 sends `revealAt: null` until the countdown's time is fixed (and again
    // while paused); kind/effect/yourEffect are absent until then.
    revealAt: typeof raw.revealAt === 'number' && Number.isFinite(raw.revealAt) ? raw.revealAt : undefined,
    endsAt: typeof raw.endsAt === 'number' && Number.isFinite(raw.endsAt) ? raw.endsAt : undefined,
    kind: raw.kind === 'photo' || raw.kind === 'video' ? raw.kind : undefined,
    yourEffect: normalizeStreakEffect(raw.yourEffect),
    effect: normalizeRoundEffect(raw.effect),
    eliminated: Array.isArray(raw.eliminated) ? raw.eliminated.filter((id): id is string => typeof id === 'string') : [],
  };
}

/** Fills in fields an older server may not send. */
export function normalizeView(raw: RoomView): RoomView {
  const settings = normalizeSettings(raw.settings);
  return {
    ...raw,
    settings,
    bunch: normalizeBunch(raw.bunch, settings.mediaMode),
    players: (raw.players ?? []).map((player) => ({ ...player, items: normalizeItems(player.items) })),
    round: normalizeRound(raw.round),
    shop: normalizeShop(raw.shop),
    paused: raw.paused === true,
    pausedRemainingMs: typeof raw.pausedRemainingMs === 'number' ? raw.pausedRemainingMs : null,
    podium: raw.podium ?? [],
  };
}

export interface RoomView {
  code: string;
  phase: Phase;
  game: number;
  hostID: string | null;
  capacity: number;
  settings: RoomSettings;
  /** Each player's bunch requirement; absent from an M3 server (normalized). */
  bunch: BunchRequirement;
  serverNow: number;
  phaseEndsAt: number | null;
  /** The host paused the game; timers are frozen at `pausedRemainingMs`. */
  paused: boolean;
  pausedRemainingMs: number | null;
  startBlocker: string | null;
  players: PlayerView[];
  /** Everything the viewer is told about themselves. No media, ever. */
  you: { id: string };
  round: RoundView | null;
  lastResult: RoundResult | null;
  /** The shop during results (viewer only); null when it is closed or absent. */
  shop: ShopView | null;
  podium: PodiumRow[];
}

// ---- server → client ----

/** Sent only to the slot owner's sockets. The UI must never react visibly. */
export interface TurnMessage {
  type: 'turn';
  slot: string;
  game: number;
  round: number;
  mode: MediaMode;
  /** M3 §7: the kind this round needs. Absent from older servers. */
  kind?: MediaKind;
}

/** Header of a binary media frame: [4-byte BE length][JSON header][bytes]. */
export interface MediaHeader {
  type: 'media';
  game: number;
  round: number;
  kind: MediaKind;
  contentType: string;
}

export type ServerMessage =
  | { type: 'state'; state: RoomView }
  | { type: 'session'; token: string; expiresAt: number }
  | { type: 'error'; message: string; request?: string }
  | { type: 'closed'; reason: string }
  /** M5 §2: echoes the ping's id. An M4 server sends no id; ignore those. */
  | { type: 'pong'; id?: number; serverNow: number }
  | TurnMessage;

// ---- client → server ----

export type ClientMessage =
  | { type: 'deck'; photos: number; videos: number }
  | { type: 'pass'; slot: string }
  | { type: 'needMedia'; round: number }
  | { type: 'ready'; ready: boolean }
  | ({ type: 'settings' } & Partial<RoomSettings>)
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  /** M5 §4: elapsedMs is optional so an M4 server (and M4 timing) still works. */
  | { type: 'guess'; targetID: string; elapsedMs?: number }
  | { type: 'useFiftyFifty' }
  | { type: 'buy'; item: ShopItem }
  | { type: 'advance' }
  | { type: 'end' }
  | { type: 'playAgain' }
  | { type: 'leave' }
  | { type: 'ping'; id?: number }
  /** M5 §1: sent once after the first state on every socket open. */
  | { type: 'hello'; caps: string[] }
  /** M5 §3: this client has the round's media decoded and ready to show. */
  | { type: 'mediaReady'; round: number };
