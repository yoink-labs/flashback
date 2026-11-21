# Milestone 5 — Fair reveal

Three fairness fixes, one release, worker + web + iOS. Everything in
docs/MILESTONE3.md and docs/MILESTONE4.md still holds unless changed here.

1. Everyone sees each round at the same moment, and nobody's guess speed is
   hurt by their connection.
2. Every effect (greyscale, blur, focus, zoom-out) runs on the same clock and
   on the same part of the photo for everyone, and every effect that hides the
   photo clears over the round, so it handicaps speed but never makes the
   round unwinnable.
3. Everyone sees the same, whole photo or video, whatever its shape and
   whatever the screen.

Old clients (no `hello`, below) keep working exactly as in M4.

## 1. Capabilities: `hello`

On every socket open (after the first `state`), a client sends
`{ "type": "hello", "caps": ["fairReveal"] }`. The server stores
`player.fairReveal = true` until the player leaves. Unknown caps are ignored.
Players without `fairReveal` are never waited on (§3) and their guesses are
timed on arrival (§4), exactly as in M4.

## 2. Clock sync

- `ping` gains an optional `id` (integer): `{ "type": "ping", "id": 7 }`. The
  `pong` echoes it: `{ "type": "pong", "id": 7, "serverNow": 1795290000000 }`.
- Client: for each pong, `rtt = t1 − t0` and
  `offset = serverNow + rtt / 2 − t1`, where t0/t1 are local send/receive
  times from a monotonic source (web `performance.timeOrigin + performance.now()`;
  iOS a monotonic clock anchored to wall time once). Keep the last 8 samples
  and use the offset of the one with the **lowest rtt**.
- On every socket open: 5 pings, 200 ms apart; then one every 15 s. Until the
  first pong, fall back to `state.serverNow − localNow` (the M4 behaviour).
- `serverNow()` everywhere (timers, effects, reveal) = `localNow + offset`.

## 3. Scheduled reveal

The reveal time is fixed **ahead of time**, only once everybody has the media,
and every client flips to the reveal on its own at that server time.

- After a client has the round's media **decoded and ready to show** (photo:
  decoded image; video: first frame decodable / `canplay`), it sends
  `{ "type": "mediaReady", "round": <index> }`. Owners may send it too (ignored).
  Media for the next round often arrives during the current round: send the
  ack whenever it's ready; the server keeps acks per slot.
- Server, during `countdown`, once the round's slot is `ready` (uploaded):
  the reveal time is **fixed** at the first moment either
  - every **connected**, non-owner player with `fairReveal` has acked that
    slot, and, if any connected non-owner player lacks `fairReveal`,
    `slot.readyAt + MEDIA_SETTLE_MS` (1.2 s) has passed; or
  - `slot.readyAt + MEDIA_WAIT_MAX_MS` (4 s) has passed (someone's connection
    is too slow; don't hold everyone).
  When fixed at time `t`: `phaseEndsAt = max(countdownStart + COUNTDOWN_MS,
  t + REVEAL_LEAD_MS)` with `REVEAL_LEAD_MS = 800`, and the round's effects
  are decided right then (§5 uses the same rules as M4 §3/§4; streaks can't
  change during a countdown).
- Countdown view (`phase: 'countdown'`) gains, once fixed:
  `round.revealAt` (= `phaseEndsAt`), `round.kind`, `round.effect`,
  `round.yourEffect`. Before it's fixed: `round.waiting: true`,
  `phaseEndsAt: null`, `round.revealAt: null`, and `kind` / `effect` /
  `yourEffect` are **absent** (an open round must not say which kind it
  needs). While a fixed countdown is paused, `revealAt` is null again. (`waiting` now means "the
  reveal time isn't fixed yet", not only "no upload yet".)
- Server reveal tick at `phaseEndsAt`: `revealAt = phaseEndsAt` when the alarm
  runs within `LATE_ALARM_MS` (1 s) of it; otherwise `revealAt = now` (a late
  alarm still gives the round its full time; clients re-base on the reveal
  state). `endsAt = revealAt + timer`. Guessers = connected players at the
  reveal (as M4).
- Pause during a fixed countdown: on resume the countdown restarts as in M3
  and the planned `revealAt` moves with `phaseEndsAt`. Clients always read
  `revealAt` from the latest view.
- **Client local reveal:** in `countdown`, when `round.revealAt` is set and
  `serverNow() >= revealAt` and the media is ready, show the reveal screen
  immediately (with `kind`, `effect`, `yourEffect` from the countdown view),
  without waiting for the `reveal` state message. A pick made before the
  `reveal` state arrives is shown as selected and held, then sent the moment
  the reveal state arrives (its `elapsedMs` measured at the tap, §4).
  If the media isn't ready at `revealAt`, show the reveal as soon as it is.

## 4. Guess timing

- `guess` gains `elapsedMs` (number):
  `{ "type": "guess", "targetID": "…", "elapsedMs": 2840 }` =
  `serverNow()` at the tap − `max(revealAt, serverNow() when this client first
  displayed the media)`. Paused time is excluded automatically because the
  server shifts `revealAt` on resume.
- Server: `serverElapsed = max(0, now − revealAt)`. For a `fairReveal`
  player with a finite `elapsedMs ≥ 0`:
  `elapsed = clamp(elapsedMs, max(0, serverElapsed − LAG_ALLOWANCE_MS), serverElapsed)`
  with `LAG_ALLOWANCE_MS = 1000`; otherwise `elapsed = serverElapsed`. A
  client can never claim to be slower than the server saw, nor more than 1 s
  faster. `elapsed` drives speed points and the sharp-eyes bonus.
- Grace: the reveal phase's deadline is `phaseEndsAt = endsAt +
  GUESS_GRACE_MS` (600 ms) so a guess sent just before time-up still lands.
  A guess is accepted while `now ≤ endsAt + GUESS_GRACE_MS` **and**
  `elapsed ≤ timer` ("Time is up." otherwise). The view's `round.endsAt` is
  still `revealAt + timer`; clients show the timer against `endsAt`, never
  `phaseEndsAt`. Everyone-guessed still ends the round at once.
- A guess on an eliminated target is still 422 (M4).

## 5. Effects: same clock, same pixels, always clearing

All effects are drawn from `serverNow() − revealAt` (frozen while paused), so
every viewer sees the same effect state at the same moment.

- **Blur (streak) now clears**: radius =
  `base × max(0, 1 − elapsed / (0.75 × timerMs))`, linear, where `base` is the
  M4 strength (light 2%, medium 4%, heavy 7% of the media's shorter side). It
  is fully sharp by 75% of the timer. Chip text unchanged.
- Greyscale: unchanged (100%, the whole round; it never hides who it is).
- Focus and zoom-out: unchanged maths (they already clear over `spanMs`).
- Streak blur and focus blur add up, as in M4.
- Every effect is applied to the **media's own displayed rectangle** (§6),
  never the screen box: blur radius uses the displayed media's shorter side,
  zoom's origin is a fraction of the media's width/height, and the zoomed
  media is clipped to its own rectangle.

## 6. Same framing for everyone

- On the reveal and the results media, photos and videos are shown **whole**
  (aspect fit / `object-fit: contain`, `.resizeAspect`, `.scaledToFit`) on
  every layout and device: phone portrait, the Duo cover and inner displays,
  desktop web. No crop anywhere a guess is made. The letterbox is the stage's
  dark background (no blurred copy of the photo: it would leak colour past
  greyscale and detail past focus).
- The media sits in a box with the media's own aspect ratio (from its
  natural pixel size), centred in the stage. Effects (§5) attach to that box.
- Deck tiles and small thumbnails may stay square-cropped (they're your own
  picks, or shown after the round).
- **Upload sizing (both clients):** photos scale by area, not long edge:
  `scale = min(1, sqrt(1_555_200 / (w × h)), 3072 / max(w, h))`
  (1_555_200 = 1440 × 1080). A 4:3 photo stays 1440 × 1080; an 8000 × 1600
  panorama becomes about 2789 × 558 instead of 1440 × 288. JPEG quality and
  metadata stripping are unchanged. Videos are unchanged.

## 7. Constants (worker, exported)

`MEDIA_SETTLE_MS = 1200`, `MEDIA_WAIT_MAX_MS = 4000`, `REVEAL_LEAD_MS = 800`,
`LATE_ALARM_MS = 1000`, `LAG_ALLOWANCE_MS = 1000`, `GUESS_GRACE_MS = 600`,
`BLUR_CLEAR_FRACTION = 0.75` (client constant).
