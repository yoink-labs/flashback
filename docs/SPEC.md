# Flashback specification

Flashback is Yoink Labs' free, open-source Photo Roulette party game. Players join a realtime room and take turns guessing who a randomly chosen photo or short video belongs to. Phone and browser players share the same rooms.

This document is the source of truth for Milestone 1: the Cloudflare Worker and Durable Object backend, the full web app, the native SwiftUI iOS app, tests, and CI. Implementation should follow it and the same Yoink Labs conventions used by [Split](https://github.com/yoink-labs/split).

## Principles

- Free, no paywall, no Pro tier. Do not mention tipping in the product UI or README marketing copy yet.
- Free Cloudflare tiers only (Workers, Durable Objects, R2). No paid APIs.
- Privacy first: media exists only for the active game and is deleted as soon as the round or game ends, with a short TTL as a backstop.
- Guest-friendly: a room code and a nickname are enough to play. Clerk sign-in is optional, not required.
- Web and iOS players must play together seamlessly, including mixed photo and video rounds.
- Permissive-license code only, with attribution. MIT for this repo (copyright Undrift LLC, 2026), matching Split.

## Platforms

- **Native iOS:** SwiftUI, iOS 18+, XcodeGen, Xcode 27 / iOS 27 SDK, iPhone and iPad, iPhone Duo responsive (folded, open wide, open tall, and folding mid-flow). Use `AVKit` for video playback and system haptics for ready, reveal, correct/incorrect, and podium moments. Planned bundle ID: `com.yoinklabs.flashback`. Development team: `64PUT29XZ8` (same as Split).
- **Web app:** Vite, React 19, React Router 7, TypeScript, same pattern as Split's `web/` (Clerk JS loaded from `clerk.yoinklabs.dev`, no `@clerk/clerk-react` package required). Responsive desktop and mobile. The Worker serves `web/dist` as assets with SPA `not_found_handling`, `run_worker_first` for API and WebSocket paths.
- **Backend:** one Cloudflare Worker with a Durable Object per room and an R2 bucket (or DO-scoped store plus R2) for ephemeral media.

Keep the system default Xcode (26.4.1) unchanged. Local iOS builds and tests must set `DEVELOPER_DIR=/Applications/Xcode-27.2.0.app/Contents/Developer`. GitHub Actions should use the `xcode-27` runner and `DEVELOPER_DIR=/Applications/Xcode_27.2.app/Contents/Developer`, matching Split.

## Identity and access

Flashback supports **two ways in**, on both web and iOS, and they must work in the same room.

### Guest play (required, no account)

Friends can jump into a room without creating an account.

- **Join:** enter the 6-character room code (or open the shareable join URL) and a nickname.
- **Create:** a guest may also create a room, choose a nickname, and become the host. Sign-in is not required to host.
- The Worker (or room Durable Object) issues a short-lived, room-scoped guest session token (signed by the Worker, not a Clerk session). Store it in memory / `localStorage` / Keychain as appropriate. It authorizes only that room, that nickname, and that guest id.
- Nicknames are display-only, 1–24 visible characters after trim, unique within the room (case-insensitive). Reject empty, whitespace-only, or colliding names with a clear error.
- Guests can fully play: lobby, ready, upload, guess, score, and Play Again in the same room.
- Guest sessions end when the guest leaves, the game is torn down, or the token expires. They must not become Clerk users automatically.
- Do not collect email, phone, or other account data from guests.

### Optional Clerk sign-in

Players who already have a Yoink Labs account can sign in with the **existing shared production Clerk instance** used by Wanderer, Split, and yoinklabs.dev.

Reuse Split's exact auth pattern. Do **not** modify Clerk OAuth settings, redirect URLs, or Wanderer's shared sign-in setup in this milestone. Copy the publishable key from Split's existing client files when implementing; never invent keys and never commit secret keys.

- **Issuer:** `https://clerk.yoinklabs.dev`
- **JWKS:** `https://clerk.yoinklabs.dev/.well-known/jwks.json`
- **Web:** load Clerk JS from `https://clerk.yoinklabs.dev/npm/@clerk/clerk-js@5.128.2/dist/clerk.browser.js` with `data-clerk-publishable-key` set to the same live publishable key Split uses. Use `window.Clerk` (`load`, `mountSignIn`, `session.getToken()`, `signOut`), the same way Split's `web/` does.
- **iOS:** Clerk iOS `ClerkKit` exact version `1.7.1`, `Clerk.configure(publishableKey:)` with that same publishable key, session restore, Apple / Google / email as already offered by the shared instance.
- **Worker:** verify Clerk RS256 JWTs with `jose` (`createRemoteJWKSet` + `jwtVerify`), `issuer` from `CLERK_ISSUER`, required claims `exp`, `sub`, `iat`, and an allowed-party check like Split's `validParty`. Allowed `azp` values for Flashback will later include `https://flashback.yoinklabs.dev` and `com.yoinklabs.flashback` (plus the existing shared origins if needed). The Worker needs no Clerk private key. `CLERK_SECRET_KEY` may be declared as a Wrangler secret for future admin/QA use, matching Split, but gameplay must work for guests without it.
- Signed-in players use their Clerk `sub` as a stable user id and may use their Clerk display name, or set a room nickname.
- A signed-in player and a guest must be able to share a room. WebSocket authorization accepts either a valid Clerk bearer token or a valid guest session token.

Adding `flashback.yoinklabs.dev` (and the iOS URL scheme / bundle) as a Clerk allowed origin is **external setup for later**. Do not change the Clerk dashboard in this milestone. Local development can use `wrangler dev` and the existing publishable key the way Split does.

## Rooms and realtime

- Creating a room allocates a Durable Object and a unique **6-character room code** (uppercase letters and digits, avoid ambiguous characters such as `0/O/1/I`).
- Shareable join URL, for example `https://flashback.yoinklabs.dev/join/ABC123`, plus a QR code and a native share sheet on iOS.
- All lobby, ready, countdown, reveal, guess, score, and podium events go over a WebSocket to that room's Durable Object. HTTP is used for room create/join, session issue, and media upload.
- Host controls: rounds, timer length, media mode (**Photos**, **Videos**, or **Both**), and start / play again. Non-hosts can ready up and leave. If the host disconnects, transfer host to the longest-present remaining player, or end the room if empty.
- Capacity safeguard (not a paid upgrade): cap rooms at a reasonable size (for example 12 players). Reject additional joins clearly.
- Empty rooms, finished rooms after a short grace period, and abandoned connections are cleaned up. Codes may be reused only after the Durable Object is gone.

## Game loop

1. **Lobby.** Show room code, QR / share link, player list with host and ready state, and settings (rounds, timer, media mode). Everyone must ready up (or the host starts when at least two players are ready — pick one consistent rule, document it in the UI, and test it). Block start if a player's library cannot satisfy the chosen media mode.
2. **Round countdown.** Short countdown with haptics on iOS. The next media item is chosen server-side so clients cannot peek.
3. **Reveal.** Show a photo, or an auto-playing looping video with a mute/unmute toggle (start muted on web to satisfy autoplay policy; iOS may start muted as well and let the player unmute). Do not show the owner.
4. **Guess.** Each other player guesses who owns the item before the timer runs out. The owner sits this guess out. Late or missing guesses score zero.
5. **Scoring.** Award points for accuracy, remaining time (speed), and consecutive correct guesses (streak). The formula should be deterministic, documented in code, and covered by unit tests. Tie-break by earlier correct guess, then by join order.
6. **Round reveal.** Show the owner, each guess, score deltas, and updated totals.
7. **Final podium and Play Again.** Rank players after the last round. The host can start another game in the same room (settings may be adjusted). Guest and Clerk sessions in that room remain valid.

Media for a round is selected from the owning player's contributed pool (random, without replacement within a game when possible). The server, not the client, picks the item and its owner.

## Media pipeline

### iOS

- Random selection of photos **and** videos from the player's library with `PhotoKit` / `PHPicker` (and limited-library access). Request only the access needed, with a clear purpose string.
- On-device image compression before upload (reasonable display size and quality, small enough for a party round).
- On-device video trimming and transcoding to a **5–8 second H.264 MP4 clip, at most 8 MB**, before ephemeral upload. Do not upload the original library file.
- Playback with `AVKit`. Handle folding / size-class changes without losing in-progress lobby, guess, or playback state.

### Web

- Multi-file photo and video selector (`<input type="file" accept="image/*,video/*" multiple>` or equivalent).
- Client-side image compression and video clip handling so a web player can sit in the same room as iOS players. Target the same clip constraints (about 5–8 seconds, H.264 MP4, ≤ 8 MB). If a browser cannot transcode a particular file, show a clear error and ask for a shorter or smaller clip rather than uploading a huge original.
- Looping video reveal with a mute toggle; respect autoplay rules.

### Ephemeral storage and privacy

- Upload only to R2 or a Durable Object–scoped ephemeral store, under a key bound to the room and round.
- Authorize uploads with the player's Clerk or guest session. Enforce content type, size, and duration limits on the server too.
- Delete media immediately when the round ends, when the game ends, when the room is destroyed, and when a player leaves before their unused items are shown. A short TTL (for example 1–2 hours) is a backstop, not the primary deletion mechanism.
- Do not persist library identifiers, EXIF that can locate a person, or media in D1. Logs must not include media bytes or signed URLs in full.
- Media URLs must be short-lived and unguessable. Other players receive them only during the reveal window.

## Suggested layout

Follow Split's repository shape so Yoink Labs contributors can move between apps:

```
README.md
LICENSE
.gitignore
docs/SPEC.md
project.yml                 # XcodeGen
Flashback/                  # SwiftUI app
FlashbackTests/
web/                        # Vite + React + TypeScript
worker/                     # Cloudflare Worker + Durable Objects + tests
  wrangler.jsonc
  src/
  test/
.github/workflows/checks.yml
scripts/check.sh
```

Worker stack should match Split where it fits: TypeScript, Wrangler 4, Vitest with `@cloudflare/vitest-plugin`, `jose` for Clerk JWTs, compatibility date on or after Split's `2026-11-16` if the local workerd supports it. Planned Worker name `flashback`, Cloudflare account the same Yoink Labs account Split uses (`2bc9c3c136a62ea9dcbddaa6f59edca4`), custom domains later: `flashback.yoinklabs.dev` (and an API host if you split it). Do not deploy or create DNS/R2 in this milestone unless secrets and approval are already in place; prefer local `wrangler dev` and tests.

iOS: XcodeGen `project.yml`, Swift 5, deployment target iOS 18.0, `ClerkKit` 1.7.1, tests in `FlashbackTests`. Use ADE's simulator panel, not Simulator.app, when launching on this Mac.

## Tests and CI

- **Worker:** unit tests for room codes, guest session issue/validate, Clerk JWT verification (with fixtures, no real secrets), ready/start rules, media-mode constraints, scoring (accuracy, speed, streak, ties), WebSocket state machine, and deletion/TTL behavior.
- **Web:** typecheck and a focused test or build-time check that guest join and Clerk sign-in paths both exist.
- **iOS:** unit tests for scoring, session/guest token handling, and media constraint helpers; `xcodebuild test` on iOS 27.2 with Xcode 27. Duo layout should compile and not discard in-progress state on size-class change. All tests must also be runnable on iOS 26.4 if a 26 SDK simulator is used, but CI uses 27.2.
- **GitHub Actions:** a `Checks` workflow like Split's — Worker/web job on `ubuntu-latest` with Node 22; iOS job on `xcode-27` with `DEVELOPER_DIR=/Applications/Xcode_27.2.app/Contents/Developer`.

## Out of scope for Milestone 1 (later, do not block the PR)

- Creating the production Worker route, DNS, or R2 bucket
- Adding `flashback.yoinklabs.dev` or the iOS app as a Clerk allowed origin / native redirect (requires a careful, approved Clerk change later — never do this unprompted)
- App Store Connect app record, bundle registration, or TestFlight
- yoinklabs.dev marketing page and social posts
- Mentioning tipping in the product

## Standing constraints

- Never print secrets. Use `ade secrets exec` if a secret is required.
- Never modify Clerk OAuth settings or Wanderer's shared sign-in setup.
- Do not touch Wanderer's API or database, Ledgerly, Undrift/homebrew-tap, or other Yoink Labs apps except to **read** Split as a reference.
- No force-push and no history rewrite.
- Do not commit `.env`, `.dev.vars`, real Clerk secret keys, or real Apple credentials.
