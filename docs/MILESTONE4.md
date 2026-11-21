# Flashback Milestone 4: Arcade (effects, power-ups, shop, Even Split, shared player)

Contract for Milestone 4. Extends `docs/MILESTONE3.md` (which extends M2 and
`docs/DESIGN.md`) and overrides them where they disagree. Worker, web and iOS
must all follow it exactly so mixed rooms work. Old clients must keep working
(every new field has a default; unknown fields are ignored).

Everything here is **host-configurable in the lobby settings sheet** and
**visible to everyone** in the lobby (chips under the settings row) and in the
join preview.

## 1. Settings

```ts
interface Settings {
  rounds: number;          // 1–100 (was 1–30), default 10
  timerSeconds: number;    // 10–60, default 20 (unchanged)
  mediaMode: 'photos' | 'videos' | 'both';
  breakSeconds: number;    // 3–30, default 7 (unchanged range)
  swaps: number;           // 0–10, default 3 (unchanged)
  evenSplit: boolean;      // default false                       (§2)
  effects: {
    greyscale: { enabled: boolean; trigger: 'right' | 'wrong'; after: number };        // false, 'right', 3
    blur:      { enabled: boolean; trigger: 'right' | 'wrong'; after: number;
                 strength: 'light' | 'medium' | 'heavy' };                             // false, 'right', 5, 'medium'
    focus:     { enabled: boolean; frequency: 'every' | 'half'; span: 25 | 50 | 75 | 100 };            // false, 'every', 50
    zoom:      { enabled: boolean; frequency: 'every' | 'half'; span: 25 | 50 | 75 | 100; scale: 2 | 3 | 4 }; // false, 'every', 50, 4
  };
  powerups: {
    fiftyFifty: { enabled: boolean; after: number };   // false, 3   (§5)
    shop: { enabled: boolean };                        // false      (§6)
  };
}
```

- `after` ranges: 2–10.
- Validation (`422`, short message): every field type/range; if greyscale and
  blur are both enabled **with the same trigger**, `blur.after` must be greater
  than `greyscale.after` ("Blur has to start after greyscale.").
- Patch format: the `settings` client message may include any of the top-level
  keys. `effects` and `powerups` are sent **whole** (the client sends the full
  object; the server validates and replaces it). `evenSplit` is a boolean.
- Missing/invalid persisted values normalize to defaults.
- `GET /v1/rooms/:code` returns the full settings (join preview shows the chips).

## 2. Even Split (`settings.evenSplit`)

Each person's bunch is sized so every photo they deal can be shown.

- **Bunch requirement.** The server exposes the room's requirement as a new
  top-level view field `bunch: { photos: number, videos: number }` (also in
  `GET /v1/rooms/:code`). Clients size their bunches from it instead of
  constants.
  - Even Split off: as M3 — `photos` mode `{12,0}`, `videos` `{0,6}`, `both`
    `{12,6}`.
  - Even Split on: `share = ceil(rounds / max(players, 1))`. `photos` mode
    `{share,0}`; `videos` `{0,share}`; `both`: `videos = round(share / 3)`,
    `photos = share - videos`.
  - It updates live as players join/leave or settings change. Readiness is
    **kept**; the start blocker simply waits until every bunch fits
    (`deckFits` uses `bunch`). Clients keep each bunch at exactly the required
    size: when it grows they auto-deal the extra tiles (iOS from the library;
    web from the pool, otherwise show the shortfall); when it shrinks they drop
    tiles from the end.
- **Schedule (server, at `start`).** `n` players, `base = floor(rounds/n)`,
  `extra = rounds % n`: `extra` random players own `base + 1` rounds, the rest
  `base`. Each owner's rounds are split into kinds: `both` →
  `v = round(c/3)` video rounds and `c - v` photo rounds; otherwise all of the
  mode's kind. Then order the rounds: repeatedly pick, at random among the
  owners with the most remaining rounds, one that is not the previous round's
  owner (if possible); take one of that owner's remaining kinds at random.
  Store as `state.schedule: { ownerID, kind }[]` (never sent to clients).
- Slots in Even Split use the schedule's owner and kind. If that owner is gone,
  disconnected, or fails/passes, fall back to the normal `pickOwner` for that
  round (keeping the scheduled kind). Shares are **hidden**: nothing in the view
  reveals how many rounds anyone owns.
- Rounds may be 1–100 in every mode; without Even Split, bunches recycle as in M3.

## 3. Streak effects: Greyscale and Blur (per player, private)

- New player counter `missStreak`: consecutive wrong or missing guesses on
  rounds that weren't theirs; reset to 0 by a correct guess; unchanged on their
  own rounds. (`streak` is the existing consecutive-correct counter.)
- At the moment a reveal begins, for each guesser who is **not the owner**:
  `count(trigger) = trigger === 'right' ? streak : missStreak`.
  `effect = blur` if blur enabled and `count(blur.trigger) >= blur.after`; else
  `greyscale` if enabled and `count(greyscale.trigger) >= greyscale.after`; else
  none. The owner never gets a streak effect. The effect lasts as long as the
  streak (it's recomputed every round).
- Applies to photos and videos. Blur radius as a fraction of the media's shorter
  side: light 2%, medium 4%, heavy 7%. Greyscale = 100% desaturation.
- View (reveal, viewer only): `round.yourEffect: { kind: 'greyscale' | 'blur',
  strength?: 'light'|'medium'|'heavy', trigger: 'right'|'wrong', streak: number }
  | null`.
- Client label on the media (top-leading chip): "Greyscale · 3 right in a row" /
  "Blur · 5 wrong in a row".

## 4. Round effects: Focus and Zoom-out (everyone, same for all)

- At reveal start the server decides `round.effect`:
  for each enabled effect, it applies if `frequency === 'every'`, or with 50%
  chance if `'half'`; if both apply, pick one at random.
- `round.effect: { kind: 'focus' | 'zoom', spanMs: number, scale?: 2|3|4,
  originX?: number, originY?: number } | null` where
  `spanMs = timerSeconds * 1000 * span / 100`, and zoom's origin is a random
  point in [0.25, 0.75]² (fractions of width/height). Same for every viewer.
- Rendering (time from the server clock: `revealAt` + skew):
  - Focus: blur radius 8% of the shorter side at `revealAt`, easing out to 0 at
    `revealAt + spanMs`.
  - Zoom-out: scale `scale` → 1 around the origin over `spanMs`, ease-out.
  - Stacks with a streak effect (e.g. greyscale + zoom). Freezes while paused.
  - Chip on the media: "Focus · guess early for a bonus" / "Zoom-out · guess
    early for a bonus".
- **Sharp eyes bonus:** a correct non-owner guess while a round effect is
  active earns `bonus = round(200 × max(0, 1 − elapsedMs / spanMs))`, added to
  the round points. Owner decoy stays 0.

## 5. 50/50 (earned, banked)

- If `powerups.fiftyFifty.enabled`: whenever a correct guess makes a player's
  `streak` a positive multiple of `after`, they earn one 50/50 (max **2** held).
- Use: during reveal, before guessing, client sends `{ "type": "useFiftyFifty" }`.
  Server checks: phase reveal, not paused, viewer `canGuess`, holds ≥ 1, not
  already used this round. It removes one charge and greys out
  `floor(w / 2)` random **wrong** choices, where wrong choices = every player
  in the room except the owner **and the viewer** (who already knows it isn't
  theirs). Stored per round per player. When `floor(w / 2) == 0` (3 or fewer
  players for a guesser) it's refused with `409` "There is nobody to cut this
  round." and **no charge is used**; clients disable the button when
  `players.length - (viewer is owner ? 1 : 2) < 2`.
- Guessing a player in your `eliminated` list is refused with `422` "Your
  50/50 ruled that player out."
- View (reveal, viewer only): `round.eliminated: string[]` (empty when unused).
- If used on your own round (you're the owner), the charge is **refunded** when
  the round finishes.
- Can also be bought in the shop (§6), even when the earn rule is off.

## 6. Shop between rounds

Enabled by `powerups.shop.enabled`.

| item | id | price | effect |
| --- | --- | --- | --- |
| Double Down | `doubleDown` | 250 | Armed for your next round as a guesser: correct → round points ×2; wrong or no guess → lose 300 |
| Shield | `shield` | 200 | Your next miss keeps your `streak`, doesn't add to `missStreak` (so no greyscale/blur from it), then it's used up |
| 50/50 | `fiftyFifty` | 400 | One 50/50 charge (§5) |

- Open during `results` (the break) except after the final round.
  When the shop is enabled, the results phase lasts
  `max(breakSeconds, 12)` seconds (`SHOP_MIN_BREAK_SECONDS = 12`), except the
  final round's results, which keep plain `breakSeconds` (the shop is closed).
- `{ "type": "buy", "item": "doubleDown" | "shield" | "fiftyFifty" }`:
  one purchase per player per break; hold at most 1 Double Down, 1 Shield,
  2 50/50s; price must be ≤ current score (**no buying you can't afford**);
  the price is subtracted from `score` immediately. Not while paused. Errors:
  `409` "The shop is closed." / "One buy per break." / "You already have one.";
  `422` "Not enough points." / unknown item.
- Double Down resolves at the next reveal where the player is a guesser and not
  the owner. If the player turns out to be the round's owner, it is **not
  used** (stays armed — "refunded") and the result row says so. If they aren't
  a guesser (joined late, disconnected at reveal start) it stays armed.
- Shield is consumed only by a miss on a non-owner round.
- Score never goes below 0 (penalties clamp).
- **Public:** `players[].items: { doubleDown: 0|1, shield: 0|1, fiftyFifty: 0|1|2 }`
  is visible to everyone; clients show small icons by avatars (guess grid,
  lobby/results rows).
- View (results, viewer only): `shop: { open: boolean, bought: boolean,
  prices: { doubleDown: 250, shield: 200, fiftyFifty: 400 } } | null`.

## 7. Scoring and results rows

Per non-owner guesser, in this order:
1. `base` = existing `scoreGuess` (accuracy + speed + streak bonus).
2. `bonus` = sharp eyes (§4) if correct.
3. Double Down if armed: correct → `points = (base + bonus) × 2`;
   wrong/missing → `points = −300` (applied to score with a floor of 0).
4. Shield on a miss: streak and missStreak unchanged, shield consumed.
5. 50/50 earn check (§5).

`ResultRow` gains: `bonus: number`, `doubleDown: 'won' | 'lost' | 'refunded' |
null`, `shielded: boolean`, `effect: 'greyscale' | 'blur' | null`,
`roundEffect: 'focus' | 'zoom' | null`, `fiftyFifty: boolean`,
`earnedFiftyFifty: boolean`. `points` is the signed delta actually applied.

Client "you" card shows the breakdown under the round points when relevant:
"Sharp eyes +120", "Double Down ×2" / "Double Down −300" / "Double Down kept
(your photo)", "Shield saved your streak", "+1 50/50".

## 8. Shared video player (clients)

One player instance per device; at most one clip plays at a time.

- **Web:** a module-level `PlaybackHub` owning a single `<video>` element (muted
  by default) that is re-parented into whichever surface needs it: deck tile
  hover, the hold/lightbox preview, the reveal, the results thumbnail.
  - Hover play: on devices with `(hover: hover) and (pointer: fine)`, hovering a
    **video** tile for 250 ms plays that clip inline in the tile (muted, loop);
    leaving stops it. Touch devices keep hold-to-preview.
- **iOS:** one shared `AVPlayer` owned by the store, used by the deck preview,
  the inline hover preview (`.onHover` / `onContinuousHover`, iPad pointer and
  trackpad), the reveal and results. Long-press still opens the preview on
  iPhone.

## 9. Settings sheet and lobby UI

Settings sheet: three groups — **Game** (Show, Rounds stepper 1–100 with chips
5/10/20/30/50/100, Time to guess, Between rounds with chips 3/5/7/10/15/20/30,
Swaps, Even Split toggle with caption "Everyone deals rounds ÷ players. Every
photo gets shown."), **Effects** (four rows: toggle; when on, the row expands
with its controls: trigger segmented "Right streak / Wrong streak", "After"
stepper, blur strength chips, frequency segmented "Every round / Half the
rounds", span chips 25/50/75/100%, zoom chips 2×/3×/4×), **Power-ups** (50/50
toggle + "Earn after" stepper; Shop toggle with the three items and prices
listed in one caption line). When the shop is on and Between rounds is < 12,
show "Shop rounds last 12 s" under the break chips.

Lobby: under the settings summary row, a wrapping row of small chips (icon +
short label) for everything enabled: "Even Split", "Greyscale 3↑" (↑ right
streak / ↓ wrong streak), "Blur 5↑", "Focus", "Zoom-out", "50/50", "Shop".
Same chips in the join preview. Icons (SF Symbols on iOS, matching SVGs on web):
greyscale `circle.lefthalf.filled`, blur `drop.fill`, focus `scope`, zoom
`plus.magnifyingglass`, 50/50 `scissors`, shop `cart.fill`, even split
`equal.circle.fill`, Double Down `die.face.5.fill`, Shield `shield.fill`.

Reveal: viewer's power-up bar under the title (only when relevant): "50/50 ×1"
button (disabled after use / when guessed), "Double Down armed" and "Shield on"
status pills. Public item icons on avatars in the guess grid.

Results: the shop strip (when open) below the "you" card: three equal cards
(icon, name, one-line effect, price) with disabled reasons ("Not enough
points", "You have one", "Bought ✓", "One per break"). Your points update
immediately after buying.
