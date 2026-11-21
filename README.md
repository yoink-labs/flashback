# Flashback by Yoink Labs

A free, open-source [Photo Roulette](https://photoroulette.app) party game with **full photo and video support**. No paywall or Pro tier.

- **Name:** Flashback · bundle `com.yoinklabs.flashback`
- **License:** MIT
- **Platforms:** native SwiftUI iOS 18+ (iPhone, iPad, iPhone Duo) and a full web app. Phone and browser players share the same rooms.
- **Identity:** guest play with a 6-character room code and a nickname (no account), **or** optional sign-in with the existing Yoink Labs Clerk instance used by Wanderer, Split, and yoinklabs.dev.
- **Realtime:** a Cloudflare Worker with one Durable Object per room, over WebSockets
- **Media:** photos and 6-second video clips. Nothing is uploaded in the lobby: each round, one player's device sends one item just before that round, the room relays it over the WebSocket, and nothing is ever stored

The architecture, gameplay, auth model, media pipeline, and conventions are in [docs/SPEC.md](docs/SPEC.md). Milestone 2 (turn-time uploads, everyone guesses, zero storage, new UI) is in [docs/MILESTONE2.md](docs/MILESTONE2.md) and overrides the spec where they differ.

## Play

1. Create a room, or join with a code, QR code, or share link (`https://flashback.yoinklabs.dev/join/ABC234`). Before you pick a nickname you see the room: host, players, mode, and rounds.
2. The host picks rounds (1–30), timer, and **Photos**, **Videos**, or **Mix**.
3. Everyone builds a **deck** on their own device: on iOS, a random shuffle from your library (or items you choose); on the web, files you pick. You see every photo and video in it and can hide any of them. The deck never leaves your device. Ready up; the host starts when everyone is ready (2 or more, up to 12).
4. Each round the server picks whose turn it is, and that player's device quietly uploads one random item from their deck while the previous round is still on screen. Nobody is told whose it is, including the owner. Guess whose it is; you can pick anyone, yourself included.
5. See the reveal and scores, then a final podium. Play again in the same room with the same decks.

### Scoring

A correct guess earns **500** for accuracy, up to **500** for speed (`round(500 × time left ÷ round time)`), and **100 per previous consecutive correct guess** (capped at 500). Wrong, late, and missing guesses earn 0 and reset the streak. The owner guesses like everyone else so nobody can tell whose it is, but since they always know their own item, their guess is a decoy: it scores 0 and leaves their streak alone. Ties: rounds rank earlier guesses first; the podium ranks less total time on correct guesses first, then join order. The server computes scores (`worker/src/scoring.ts`); iOS mirrors the formula for hints (`Flashback/Core/Scoring.swift`), and both are tested against the same cases.

## How sign-in works

Both ways in work on web and iOS, in the same room:

- **Guest:** `POST /v1/rooms` or `POST /v1/rooms/:code/join` with `{ "nickname": "Sam" }` and no `Authorization` header. Nicknames are 1–24 visible characters after trimming and unique in the room, ignoring case.
- **Signed in:** the same calls with `Authorization: Bearer <Clerk session token>`. The Worker verifies RS256 tokens with `jose` against `https://clerk.yoinklabs.dev/.well-known/jwks.json`, requires `exp`, `sub`, and `iat`, and checks `azp` (`validParty`, as in Split) against `https://flashback.yoinklabs.dev`, `com.yoinklabs.flashback`, and the shared yoinklabs.dev origins. Signed-in players keep the same seat when they rejoin.

Either way, the room returns a **room session token**: an HS256 JWT signed with a random key that exists only inside that room's Durable Object. It names one room, one player id, and one nickname, lasts 4 hours (refreshed over the socket in long games), and dies with the room. Web keeps it in `localStorage`; iOS keeps it in the Keychain. Guests never become Clerk users and no email or phone is collected.

Every authenticated call (WebSocket, upload, media, leave) accepts **either** a Clerk token or a room session token. Browsers send the token as a WebSocket subprotocol (`flashback.v1, auth.<token>`) because they cannot set headers on WebSockets; iOS does the same. No Clerk secret key is needed for gameplay or tests.

## Media and privacy

- **Only what is shown is sent.** Your deck stays on your device. One item is prepared (compressed or trimmed) ahead of time, uploaded only when the server asks for your turn, and only that one leaves the device. Hidden items are never sent; on iOS, items you hide are remembered so they are never picked again.
- **iOS:** decks come from PhotoKit (full or limited access) or the system photo picker (no permission needed). Photos become a ≤1440 px JPEG with no metadata. Videos become a random 6-second, ≤720p H.264 MP4 clip (metadata stripped) via `AVAssetExportSession`. Originals and library identifiers never leave the phone.
- **Web:** photos are decoded, resized, and re-encoded as JPEG (dropping EXIF/GPS). Videos are trimmed and re-encoded in the browser with WebCodecs and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) to the same clip format. If a browser cannot do that, it skips that file and tries another.
- **Server:** accepts only JPEG (≤3 MB, EXIF/XMP/comments stripped again) and H.264 MP4 (≤8 MB, 1–8 s, checked by reading the MP4 boxes), and only for a turn it asked that player for.
- **No storage at all.** The room's Durable Object keeps the round's item in memory only and pushes it to the other players as one binary WebSocket frame; the owner shows its own copy. It is dropped when the round ends, the game ends, or the room closes. Nothing goes to R2, D1, KV, or Durable Object storage, and logs never contain media. There is nothing to clean up.
- Rooms close 2 minutes after everyone disconnects, 15 minutes after a finished game, or after an hour idle in the lobby. Dropped players keep their seat for 90 seconds. If the host leaves or drops, the longest-present player becomes host.

## Tip the devs

Flashback is free with nothing locked. Tips are optional StoreKit 2
consumables that unlock nothing: `dev.yoinklabs.flashback.tip.small`,
`.medium` and `.large` (App Store Connect; prices always come from StoreKit).
They open from the pink "Tip the devs" capsule on Home and the row in About.
`Flashback/Resources/Flashback.storekit` mirrors them for the scheme and tests.
DEBUG screenshot flags: `-uiTipJar config` (serve the .storekit file without
StoreKit), `-uiTipOutcome thanks|pending|failed|cancel`, `-uiRoute tipJar|about`.
The web header links to https://yoinklabs.dev/tip, which explains where tipping
happens; nothing is paid on the web.

## Development

Layout follows Split: `worker/` (Worker + Durable Object + tests), `web/` (Vite + React 19 + React Router 7), `Flashback/` and `FlashbackTests/` (SwiftUI, generated with XcodeGen from `project.yml`).

```sh
# Everything CI runs
scripts/check.sh

# Web and Worker
npm ci --prefix web && npm ci --prefix worker
npm run build --prefix web          # typecheck + auth path check + vite build
npm run typecheck --prefix worker
npm test --prefix worker            # Vitest in workerd (rooms, sessions, Clerk fixtures, scoring, media, WebSockets, deletion)

# Local play: Worker on :8799 serving web/dist, plus Vite for hot reload if you like
npm run dev --prefix worker -- --port 8799
# open http://localhost:8799

# iOS (Xcode 27 / iOS 27 SDK; leave the system default Xcode alone)
xcodegen generate
DEVELOPER_DIR=/Applications/Xcode-27.2.0.app/Contents/Developer xcodebuild test \
  -project Flashback.xcodeproj -scheme Flashback \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=27.2'
```

Debug iOS builds can target a local Worker with the launch argument `-flashbackAPI http://127.0.0.1:8799`. Production Clerk only works on its allowed origins, so on `localhost` the web app hides sign-in and guest play carries on.

Never put secrets in source, logs, `.env`, or `.dev.vars`. See `worker/.env.example`.

## Deployment

Flashback is live at https://flashback.yoinklabs.dev. The one-time setup is done:

1. **R2:** not used since Milestone 2. The old bucket `flashback-media` (Yoink Labs Cloudflare account `2bc9c3c136a62ea9dcbddaa6f59edca4`, 1-day lifecycle rule `rooms-backstop`) is no longer bound to the Worker and can be deleted.
2. **Worker:** `flashback` (Durable Object class `Room` with SQLite storage, free plan). Redeploy with `npm run build --prefix web && npm run deploy --prefix worker`.
3. **DNS / route:** `flashback.yoinklabs.dev` is the Worker's custom domain (`routes` in `worker/wrangler.jsonc`).
4. **Clerk:** `flashback.yoinklabs.dev` is on the shared production instance's allowed subdomains, and `com.yoinklabs.flashback` (team `64PUT29XZ8`) is a native iOS app with redirect `com.yoinklabs.flashback://callback`. OAuth settings were not changed.
5. **Apple:** bundle ID `com.yoinklabs.flashback` has Sign in with Apple and Associated Domains (`applinks:flashback.yoinklabs.dev`). The App Store Connect app is "Flashback by Yoink Labs" (SKU `YOINK-FLASHBACK-IOS`), and TestFlight builds are made with Xcode 27.2 and the iOS 27 SDK. The Worker serves `/.well-known/apple-app-site-association`.

The Xcode project is generated: run `xcodegen generate` before building.

Optional: `wrangler secret put CLERK_SECRET_KEY` for future admin or QA tooling. Gameplay never needs it.
