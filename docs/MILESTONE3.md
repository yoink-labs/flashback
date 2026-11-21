# Flashback Milestone 3: bunches & swaps, host controls, save, web parity, iPhone Duo

This is the contract for Milestone 3. It extends `docs/MILESTONE2.md` and
`docs/DESIGN.md` and overrides them where they disagree. Worker, web and iOS
must all follow it so mixed rooms keep working.

## 1. The deck becomes a "bunch" with swaps

Old: a 24-item grid you could hide items in, plus Shuffle / Add… / Choose….
New: everyone plays with the **same rules**: a bunch of `BUNCH_SIZE = 12`
random items and a fixed number of **swaps** that the host sets
(`settings.swaps`, default 3).

- **Tap a tile = swap it.** The tile is immediately replaced with another
  random item from the pool (one the player has not seen in this session if
  possible). This uses one swap. The counter shows `3 swaps left`.
- **Hold a tile = expand it** (full preview; videos play muted). Releasing /
  closing returns to the grid. On iOS: long-press opens a full-screen preview
  (not a context menu). On web: pointer hold ≥ 350 ms (or right-click) opens a
  lightbox; a short tap swaps.
- **New bunch** replaces all 12 items with fresh random ones and resets the
  swaps to `settings.swaps`. Unlimited.
- With 0 swaps left, tapping a tile does nothing except a gentle shake and the
  counter turns `No swaps left · New bunch`.
- Swapped-out items are not drawn again this session (until the pool runs dry).
  On iOS they are also remembered across games in UserDefaults (same key as the
  old hidden list: `flashback.hiddenAssets`) so a vetoed photo never comes back.
- When `settings.swaps` changes in the lobby, each client clamps its remaining
  swaps to the new value (and a New bunch resets to it).
- There is no "hide" any more. Everything in the bunch can be shown.
- Pool:
  - **iOS, library access:** the pool is the photo library (PhotoKit, fitting
    the mode, videos ≥ 1 s).
  - **iOS without access / limited:** "Pick photos" opens the system picker
    (multi-select, up to 60). Those picks become the pool; the bunch is 12
    random from them.
  - **Web:** "Pick photos" opens the file input (multi-select,
    `accept="image/*,video/*"`; drag and drop on desktop). The picked files are
    the pool; the bunch is 12 random from them. "Add more" adds to the pool.
    Swaps draw from the pool remainder; if the pool has no unseen item left, the
    swap draws any other pool item not currently in the bunch; if none, the tile
    can't be swapped (show "Pick more photos to swap").
- The deck counts sent to the server (`{type:"deck", photos, videos}`) are the
  counts of the current bunch that fit the mode.
- Used-this-game bookkeeping (prepared-next, recycle when exhausted) is unchanged.

## 2. Settings (host only, lobby only)

`settings` = `{ rounds, timerSeconds, mediaMode, breakSeconds, swaps }`

| key | range | default | UI |
| --- | --- | --- | --- |
| `mediaMode` | `photos \| videos \| both` | `both` | segmented Photos / Videos / Mix |
| `rounds` | 1–30 | 10 | stepper (−/+), also chips 5 / 10 / 15 / 20 |
| `timerSeconds` | 10–60 | 20 | chips 10 / 15 / 20 / 30 / 45 / 60 — label "Time to guess" |
| `breakSeconds` | 3–30 | 7 | chips 3 / 5 / 7 / 10 / 15 — label "Between rounds" (length of the results screen) |
| `swaps` | 0–10 | 3 | chips 0 / 1 / 3 / 5 — label "Swaps" |

- Server validates each like the existing keys (`422` with a short message).
- `breakSeconds` replaces the fixed `RESULTS_MS`: `results` lasts
  `breakSeconds * 1000`.
- `GET /v1/rooms/:code` returns the full settings object.
- Clients must decode missing `breakSeconds` / `swaps` as the defaults (old
  servers).
- The lobby settings row summary: `Mix · 10 rounds · 20s`. (Unchanged format;
  the sheet shows everything.)

## 3. Pause (host)

New client messages (host only, else `403`):

- `{ "type": "pause" }` allowed in `countdown`, `reveal`, `results` when not
  paused (`409` otherwise).
- `{ "type": "resume" }` allowed when paused (`409` otherwise).

Server state: `pausedAt: number | null`, `pausedRemainingMs: number | null`.

- **pause:** `pausedAt = now`; `pausedRemainingMs = phaseEndsAt === null ? null :
  max(0, phaseEndsAt - now)`; `phaseEndsAt = null`.
- **while paused:** `tick` does not advance phases. Guesses → `409 "The game is
  paused."`. `advance` → `409`. Uploads are still accepted (`markReady` records
  `readyAt`, but must not set `phaseEndsAt`). Upload timeouts, disconnect
  grace, leaving and host transfer keep working. A round must not finish while
  paused (`finishIfEveryoneGuessed` is a no-op while paused). If a leave drops
  the room below 2 players the game still ends (podium), which clears the pause.
- **resume:** `shift = now - pausedAt`.
  - `reveal`: `round.revealAt += shift`, `round.endsAt += shift`,
    `phaseEndsAt = round.endsAt`; then run `finishIfEveryoneGuessed(now)`.
  - `countdown`: `round.countdownStart += shift`; if the slot is ready,
    `phaseEndsAt = now + max(pausedRemainingMs ?? COUNTDOWN_MS, 1000)`; else
    `null` (still waiting).
  - `results`: `phaseEndsAt = now + max(pausedRemainingMs ?? 0, 1000)`.
  - clear `pausedAt` / `pausedRemainingMs`.
- **auto-resume** after `PAUSE_MAX_MS = 10 * 60_000` (part of `nextDeadline`).
- `endGame`, `close`, `playAgain`, `start` clear the pause.
- `end` (host ends the game) is allowed while paused.
- **view:** top-level `paused: boolean` and `pausedRemainingMs: number | null`
  (both always present; `false`/`null` when not paused).

Clients: while `paused`, freeze timers (show the remaining time from
`pausedRemainingMs`), stop video playback, and show a calm overlay: "Paused"
(title) + "Waiting for {host}" caption for guests, a **Resume** primary button
for the host. Guess buttons are disabled while paused. The host gets a pause
button (icon `pause.fill`, 44 pt circle) in the top bar of countdown, reveal and
results, plus an "End game" action (confirm) in the pause overlay.

## 4. Save the photo

During `reveal` and `results`, everyone can save the round's media:

- **iOS:** a 44 pt circle icon button (`square.and.arrow.down`) on the media;
  saves to Photos with add-only access (`PHPhotoLibrary.requestAuthorization(for:
  .addOnly)`; add `NSPhotoLibraryAddUsageDescription`: "Save photos and clips
  from the game to your library."). Videos are written to a temp file then saved
  as video. Confirm with a short "Saved" toast + success haptic.
- **Web:** same icon button. On phones use `navigator.share({ files: [file] })`
  when `navigator.canShare({files})` (iOS Safari shows "Save Image"); otherwise
  download via an `<a download>` blob link (`flashback-round-3.jpg` / `.mp4`).
- Save is local only: it uses the bytes the client already has. Nothing new is
  sent to the server.

## 5. Web parity

The web app can do everything iOS can: host (Home → Host a game), join,
build a bunch from picked files, swap, hold to expand, settings, pause/resume,
save, play again. It must be designed **phone first** (390×844 portrait is the
primary target; also 360×740, 430×932, and landscape phones) and look like the
iOS app: same tokens, 56 pt primary button in the bottom thumb zone,
`env(safe-area-inset-*)` padding, `100dvh` layouts, no hover-only controls,
≥ 44 px targets, no horizontal scroll, `touch-action: manipulation`, no 300 ms
tap delay, `-webkit-tap-highlight-color: transparent`, and inputs at ≥ 16 px
(no iOS zoom on focus).

## 6. iPhone Duo (iOS)

Follow `~/.claude/skills/iphone-duo-*`:

- Design to size classes and the available size, never to fixed device widths.
- **Outer display / phone (compact):** one column; the bunch grid is 3 columns
  × 4 rows of large square tiles, edge-anchored controls, sticky primary at the
  bottom. Content respects the trailing 84 pt vertical bar via safe area (never
  draw under it, never draw a divider line under it).
- **Inner display (wide):** two panes meeting at the fold (each half), nothing
  interactive in the fold. In the lobby the **bunch is the canvas** (leading
  pane, tiles sized to fill the pane: 3 columns × 4 rows, or 4 × 3 when the pane
  is wider than tall) and the **room controls** (code, share, players,
  settings, Start/Ready) are the tools in the trailing pane, near the thumb and
  the vertical bar. Even gutters; the gap between panes straddles the fold.
- Use `NavigationStack` + `.toolbar` items (with both a title and an SF Symbol)
  for leave / settings / pause so iOS 27.1 can place them in the vertical bar.
- Respect reserved regions on iOS 27.1+ (`#available`): when a division region
  is active, split the panes on it.
- State survives folding (all of it lives in the stores).

---

# Amendments (round 2 of user feedback) — these override sections 1–6 above

## 7. Equal bunches: same number of photos and videos for everyone

Every player must bring the **same amount** of each kind, so nobody's camera
roll is over- or under-represented.

- `PHOTO_BUNCH = 12`, `VIDEO_BUNCH = 6` (shared constants: worker
  `game.ts`, web `deck.ts`, iOS `DeckState`).
- What a player needs, by mode:
  - `photos`: 12 photos
  - `videos`: 6 videos
  - `both` (Mix): 12 photos **and** 6 videos
- **Mix = two review steps with the same idea.** Step 1 "Photos": the photo
  bunch (12) with its own swaps. Step 2 "Videos": the video bunch (6) with its
  own swaps. Each step has `settings.swaps` swaps and its own **New bunch**.
  The UI shows a two-segment step header ("Photos 12/12 ✓" · "Videos 6/6") and,
  once the photo bunch is dealt, a primary "Next: videos" moves to step 2
  (players can switch back to either segment any time). Photos-only and
  videos-only rooms show just one step.
- Video tiles show a ▶ duration badge; hold to expand plays the clip muted.
- **Server rule (replaces "at least one item fits"):** `deckFits(deck, mode)`
  = `photos` → `deck.photos >= 12`; `videos` → `deck.videos >= 6`; `both` →
  `deck.photos >= 12 && deck.videos >= 6`. A player can't ready up (and the host
  can't start) until it fits. Start blocker wording for the viewer:
  "Deal 12 photos" / "Deal 6 videos" / "Deal 12 photos and 6 videos" (only the
  missing part, e.g. "Add 2 more videos" when they have 4 of 6), and
  "Waiting for {name}" for others. Clients send the counts of their current
  bunches that fit the mode (capped at the bunch size).
- If a player's pool doesn't have enough of a kind (e.g. only 4 videos in the
  library / picked), the step shows "You have 4 of 6 videos. Pick more or ask
  the host to switch to Photos." and the player can't ready.
- **Round kinds are balanced by the server.** In `both`, the server decides the
  kind of every round up front at `start`: a shuffled list with
  `round(rounds × 12/18)` photo rounds and the rest video rounds (so 10 rounds →
  7 photos, 3 videos). In `photos`/`videos` every round is that kind. The kind
  is stored on the slot and sent in the turn message:
  `{ type: "turn", slot, game, round, mode, kind: "photo"|"video" }`. The owner
  uploads that kind (prepared-next keeps one of each kind ready in Mix). If the
  owner can't supply that kind they `pass`. `markReady` rejects an upload of
  the wrong kind with `422`. Old clients that ignore `kind` still work as long
  as they upload the right kind; otherwise they get the 422 and the slot is
  reassigned on timeout.

## 8. Web picks many at once (like the app)

The web must never make people add photos one by one.

- One tap on "Pick photos" (or "Pick videos" in the video step) opens the
  system picker with `multiple` set and the right `accept` (`image/*` for the
  photo step, `video/*` for the video step). On iOS Safari this is the Photos
  picker with multi-select; on Android the gallery multi-select.
- Copy under the button: "Select 20 or more. We deal you 12." (videos: "Select
  10 or more. We deal you 6.").
- Picking replaces nothing: the picked files are added to the pool and the
  bunch is (re)dealt automatically to fill any empty slots. Picks of the wrong
  kind for the step are added to the right kind's pool.
- Picking must stay fast: no decoding of all files up front; thumbnails are
  generated lazily (createImageBitmap with resize, or a downscaled canvas), only
  for items in the bunch, and videos get a poster frame lazily.

## 9. Results: make your outcome obvious

Top of the results screen, after "It was {owner}'s":

- A "you" summary card: your **rank** this game ("2nd of 5"), **points this
  round** (`+640` in good colour, or `+0` / "No points" in text-2 when wrong or
  owner), **rank movement** (`▲ 1` good / `▼ 2` bad / "Held 2nd" neutral), and
  your **new total**. One line of big numbers, labels as small captions under
  them (Rank / This round / Total).
- The standings list below keeps per-player delta and movement arrows, with
  your row highlighted (surface-2 + accent left edge).
- Results length = `settings.breakSeconds`, with a thin progress bar showing
  time to the next round (frozen while paused).

## 10. A normal countdown

Replace the full-screen, scaling 3·2·1 digit. The countdown is a calm,
contained element: "Round 3 of 10" caption, then a ~96 pt circular ring that
drains smoothly around a 44 pt digit (no scale pulse beyond 1.0→1.06, no
full-screen takeover), centred in the content area with the room layout
(top bar with host pause) still visible. "Shuffling…" waiting state uses the
same ring position with the small polaroid animation. Reduce Motion: no ring
animation, digit only.
