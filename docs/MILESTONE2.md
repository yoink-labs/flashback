# Flashback Milestone 2: turn-time uploads, everyone guesses, zero storage, new UI

This is the contract for Milestone 2. It overrides `docs/SPEC.md` wherever they
disagree. Worker, web, and iOS must all follow it exactly so mixed rooms work.

## What changes and why

| Before (M1) | After (M2) | Why |
| --- | --- | --- |
| Everyone uploads a pool in the lobby before ready | Nothing is uploaded in the lobby. Each round, the server asks **one** player's device for **one** item, just before that round | Game starts in seconds; nothing is uploaded that is never shown |
| Owner sits their round out and is told "this one is yours" | **Everyone guesses, including the owner.** Nobody is told whose it is until results. Players may pick themselves. The owner's guess is a 0-point decoy | Nobody can spot the owner by who isn't guessing, and the owner gets no free points |
| Media stored in R2, fetched per player via a capability URL | **No R2.** The Durable Object holds the one item in memory and pushes it to every socket as a binary WebSocket frame. Nothing is written to any storage | Zero storage cost, nothing to clean up, fewer requests |
| Pool chosen as files you can't see well | A local **deck**: a grid of thumbnails (photos and videos) you can see, hide, shuffle, and add to **before you ready up**. The deck never leaves the device; only the one item picked for a round is uploaded | You see what could be shown and veto it |
| Rounds limited by pool size | `rounds` is the real count. Default 10, 1–30 | |

## Game rules (server)

Phases: `lobby → countdown → reveal → results → (countdown … | podium) → lobby`. `closed` as before.

### Lobby

- Each player reports their local deck size: client → `{ "type": "deck", "photos": <int 0..500>, "videos": <int 0..500> }`. Allowed in any phase (counts can drop mid-game as items are used). Stored as `player.deck = { photos, videos }`, default `{0,0}`.
- A player can ready up only if their deck has at least one item that fits the media mode (`photos` → photos > 0, `videos` → videos > 0, `both` → photos + videos > 0). Changing the mode or sending a smaller deck unreadies players who no longer fit (same as M1).
- Start rule (unchanged wording in the UI): the host can start when at least 2 players are in the room, every player is ready, and every player's deck fits the mode.
- Settings: `rounds` 1–30 (default 10), `timerSeconds` 10–60 (default 20), `mediaMode` `photos | videos | both` (default `both`).

### Slots (turn-time uploads with one round of lookahead)

A **slot** is "the item for round N". The server keeps at most `LOOKAHEAD = 2` open slots: the current round and the next one. State per slot:

```ts
interface Slot {
  id: string;            // random, 32 hex
  round: number;         // round index it is for
  ownerID: string;
  status: 'requested' | 'ready';
  requestedAt: number;
  kind?: 'photo' | 'video';   // set when ready
  attempts: number;      // owners tried for this round so far
}
```

- **Picking an owner** for a new slot: among connected players whose deck fits the mode, prefer the fewest rounds owned so far this game (count slots that reached `ready`, plus open slots); among ties, avoid the owner of the other open slot and the previous round's owner when possible; then random. Players who already failed this round's slot are excluded.
- When a slot is created the server sends **only to the owner's sockets**: `{ "type": "turn", "slot": "<id>", "game": <int>, "round": <int>, "mode": "photos|videos|both" }` (also re-sent to the owner if they reconnect while the slot is still `requested`). The owner's client picks one random unused item from its deck that fits the mode and uploads it immediately: `POST /v1/rooms/:code/media?slot=<id>` with `Content-Type: image/jpeg` or `video/mp4`. The UI must not show anything that tells the owner it is their turn.
- If the client cannot supply anything (deck empty, processing failed), it sends `{ "type": "pass", "slot": "<id>" }`.
- Reassign the slot to another owner when: the owner passes, the owner leaves or disconnects, the upload is rejected, or `UPLOAD_TIMEOUT_MS = 20_000` passes with no upload. After `attempts` reaches the number of eligible players, or nobody is eligible, the game ends (podium) after the rounds already played.
- On `start`: reset scores, create slots for rounds 1 and 2 at once (2 only if `rounds >= 2`), enter `countdown` for round 1.
- When round N's slot is consumed by its reveal, create the slot for round N+1 if it does not exist yet and N+1 ≤ rounds. (With lookahead 2, round N+1's slot is created as soon as round N's reveal begins, so its upload overlaps round N's reveal and results.)

### Upload handling (Durable Object)

- Validate exactly as M1 (`validateMedia`: JPEG metadata stripping, MP4 box check, H.264, 1–8.5 s). Size limits: photo ≤ 3 MB, video ≤ 8 MB. Reject with 409 if the slot is unknown, not `requested`, or not owned by the caller.
- Keep the bytes **in memory only** (`Map<slotID, { bytes, kind, contentType }>` on the DO instance). Never write media to `ctx.storage`, R2, or anywhere else.
- Immediately send the bytes as **one binary WebSocket frame** to every connected socket **except the owner's** (the owner's client already has its copy and shows it from that). Mark the slot `ready` (record `kind` and `readyAt`).
- Binary frame format (both directions are server → client only):

  ```
  [4 bytes: header length L, big-endian uint32][L bytes: UTF-8 JSON header][media bytes]
  header = { "type": "media", "game": <int>, "round": <int>, "kind": "photo"|"video", "contentType": "image/jpeg"|"video/mp4" }
  ```

- A socket that connects (or reconnects) while a slot is `ready` and in memory gets that frame right after its first state message. Clients may also request it: `{ "type": "needMedia", "round": <int> }` → the server re-sends the frame if it still has the bytes, otherwise ignores it.
- If the DO was evicted and the bytes are gone, the round still plays; clients that lack the media show "This one didn't load. Guess anyway or skip." There is no second copy anywhere, by design.
- Free the bytes when the slot's round ends (results), when the game ends, on reassign, and when the room closes.

### Countdown and reveal

- `countdown` for round N lasts at least `COUNTDOWN_MS = 3000`. It ends at `max(countdownStart + 3000, readyAt + MEDIA_SETTLE_MS)` where `MEDIA_SETTLE_MS = 1200` gives every client time to receive the frame. While the slot is still `requested`, `phaseEndsAt` is `null` and the view sets `round.waiting = true` (clients show "Shuffling…"). Re-pick timeouts are alarms like any other deadline.
- `reveal`: guessers are **every player present when the reveal begins, including the owner**. A guess may target **any player in the room, including yourself**. Remove the old "This one is yours" error and "Pick another player" self-check; still reject unknown targets. Reveal ends when every connected guesser has guessed, or the timer runs out.
- Scoring formula is unchanged (`worker/src/scoring.ts`) for everyone except the owner. The owner always recognises their own item, so their guess is a **decoy**: it hides who the owner is, scores 0, and leaves their streak unchanged. Their result row still shows what they picked.
- `results`: unchanged (owner, every guess, deltas, totals), `RESULTS_MS = 7000`, host can skip.

### What each player may see (`view`)

Same as M1 with these changes:

- `players[]`: drop `photos`/`videos` pool counts; add `deck: { photos, videos }`.
- `you`: `{ id }` only (no `items`).
- `round` during `countdown`: `{ index, total, waiting }`.
- `round` during `reveal`: `{ index, total, kind, revealAt, endsAt, canGuess, yourGuess, guessedCount, guesserCount }`. **No `isYours`, no `mediaPath`, nothing that differs for the owner.**
- Never send slot ids, owner ids of open slots, or anything that reveals the owner before `results`.

### Room info before joining

`GET /v1/rooms/:code` returns `{ code, phase, players, capacity, joinable, host: "<nickname>", settings: { rounds, timerSeconds, mediaMode } }` so the join screen can show "Sam's room · Photos & videos · 10 rounds · 4/12" before you join.

### Removed

- R2 binding `MEDIA` (remove from `wrangler.jsonc`, `worker-configuration.d.ts`, tests). The `flashback-media` bucket is left alone in Cloudflare; it simply stops being used.
- `GET /v1/rooms/:code/media/:cap`, `DELETE /v1/rooms/:code/media/:id`, `removeItem`, items, `ITEMS_PER_PLAYER`, `MEDIA_TTL_MS`, capability URLs, `deletePrefix`.
- WebSocket subprotocol bumps to **`flashback.v2`** (M1 clients get refused cleanly; `auth.<token>` is unchanged).

### Cost notes (why this is the cheapest design on the free plan)

- Zero R2 operations and zero stored bytes. No cleanup jobs. A room's only storage is its small DO state record, deleted when the room closes.
- One HTTP request per round (the owner's upload) instead of 1 upload + N fetches. Outgoing WebSocket frames are not billed; incoming WebSocket messages bill at 20:1.
- Clients compress hard before upload: photos ≤ 1440 px long edge, JPEG quality ~0.78 (typically 150–400 KB); video clips 6 s, ≤ 720p, ~1.5 Mbps (~1–1.5 MB). Smaller payloads mean shorter DO wall time.
- Keep the hibernatable WebSocket API; ping no more often than every 30 s.

## Client behaviour (web and iOS)

### The deck

- **iOS:** "Shuffle from my library" picks `DECK_SIZE = 24` random assets (PhotoKit, respecting the room mode; videos ≥ 1 s) and shows them as a thumbnail grid (videos show a duration badge and a short muted preview on long-press or tap-to-preview). Tap a tile to **hide** it (dimmed with an eye-slash; hidden items are never uploaded). "Shuffle again" replaces the visible ones; "Add specific…" opens `PHPickerViewController` (no permission needed) to add chosen items. Hidden asset identifiers are remembered on device (UserDefaults) so they are never picked again in any game. Library identifiers never leave the phone.
- **Web:** "Add photos & videos" (multi-file input, `accept="image/*,video/*"`, also drag and drop). Selected files show as a thumbnail grid (object URLs; videos use a `<video muted playsinline>` poster frame and duration badge, hover/tap to preview). Each tile can be hidden/removed. "Pick random 24" if they choose a lot. Files are processed only when picked for a round (see below), never all up front.
- The deck counts (visible, unhidden, fitting the mode) are sent as `deck` whenever they change.
- Deck is kept for Play Again; items already shown this session are marked used and not picked again until the deck runs out.

### Prepared-next

- From the moment the player readies up, the client keeps **one item already processed** (compressed JPEG or trimmed MP4) in memory, chosen at random from unused unhidden deck items fitting the mode (in `both` mode, random across photos and videos). On `turn`, upload it at once, then prepare another. If nothing is prepared yet, prepare then upload. If preparation fails, try the next item; if the deck is exhausted, send `pass`.
- This all happens silently. No toast, spinner, or haptic that hints "your turn".

### Receiving media

- Handle binary frames (web: `ws.binaryType = 'arraybuffer'`; iOS: `URLSessionWebSocketTask` `.data` messages, and **set `maximumMessageSize = 16 * 1024 * 1024`**, the default 1 MB would drop clips).
- Cache by `(game, round)`. When that round's reveal begins, show it. The owner shows its own prepared copy for that round (the `turn` message carries `game` and `round`, so the owner caches its uploaded copy under the same `(game, round)` key).
- If the media for the current reveal is missing, send `needMedia` once, then show the "didn't load" state.
- Free blobs/files after the round's results.

## UI/UX direction (both platforms, same look)

Research notes: party guessing games live or die on speed to first round, big legible shared moments (countdown, reveal, "it was Sam's!"), and zero setup friction. Photo Roulette's main complaints are paywalls, small video support, and privacy anxiety about what might be shown. We answer with: instant start, a visible deck you control, hide/veto, mixed photo+video, and "deleted after each round" stated plainly.

**Look:** dark "night out" theme. Background `#0B0A12`, surface `#16141F`, raised `#211E2E`, hairline `#2E2A3D`, text `#F6F5FA`, muted `#A19DB5`. Brand gradient coral → violet `#FF5A6E → #8B5CF6`; good `#2EE59D`, bad `#FF5C7A`, gold `#FFC94A`. Light mode is optional; dark first.
**Player colours:** 12 vivid colours assigned by join order (`#FF5A6E #FFB547 #FFE14A #6BE675 #2EE5C5 #4FC3FF #6C8CFF #A974FF #FF6FD8 #FF8F5A #B7E34A #E0E0F0`). Avatar = coloured circle with the initial, same everywhere (lobby, guess buttons, results).
**Type:** system rounded for display and numbers (`ui-rounded` / SF Pro Rounded), heavy weights for the room code, countdown, and scores. Body 16–17 pt.
**Shape and motion:** 20 pt radius cards, capsule buttons ≥ 52 pt tall, 4 pt spacing grid. Spring transitions between phases; countdown digits scale-pulse; reveal fades/zooms in; points count up; correct/incorrect flash with haptics on iOS. Respect Reduce Motion.

**Screens**

1. **Home:** wordmark, one line ("Guess whose camera roll it's from."), two big buttons: **Host a game** and **Join with code**. Remember the last nickname. Small footer: "Free. No account needed. Photos are deleted after each round."
2. **Join:** 6 large code boxes (auto-advance, paste-friendly, uppercase), then a **room preview card** from `GET /v1/rooms/:code` (host, players x/12, mode, rounds) before asking for a nickname.
3. **Lobby:** big tappable room code + Share / QR. Player list with avatar, name, host crown, ready check, deck summary ("24 · 3 ▶"). **Your deck** card with the thumbnail grid, hide toggles, shuffle/add. Host settings in a sheet or inline card: mode segmented control **Photos / Videos / Mix**, rounds stepper, timer chips 10/20/30/45/60. Sticky bottom bar: **Ready** (or **Start game** for the host) with the blocker text above it.
4. **Countdown:** full screen "Round 3 of 10" and a big 3·2·1. If `waiting`, show "Shuffling…" with a subtle animation instead of digits.
5. **Reveal:** media edge to edge (aspect fit on a dark backdrop), thin timer bar on top that drains, mute toggle on videos (start muted, remember the choice). Guess grid of avatar buttons for **every** player including you (label yourself "You"). After guessing: the chosen button stays lit, others dim, "Locked in · 3 of 5 guessed".
6. **Results:** "It was **Sam's**!" with Sam's avatar large, the media small beside it, each guesser's pick with ✓/✗ and +points, then standings with rank movement arrows. Host gets **Next**.
7. **Podium:** top 3 on a podium, full ranking, best streak; host **Play again**, everyone **Leave**.

**Layouts:** phone portrait one column; landscape / iPad / iPhone Duo open (wide) puts media on the left and guesses/players on the right (`RoomLayout.wide`), tall puts media on top. Folding mid-round must not reset playback, guesses, or the deck (all state lives in the store). Web: same responsive breakpoints (≥ 900 px wide → two columns).
