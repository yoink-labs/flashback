# Flashback by Yoink Labs

A free, open-source [Photo Roulette](https://photoroulette.app) party game with **full photo and video support**. No paywall or Pro tier.

- **Name:** Flashback · planned bundle `com.yoinklabs.flashback`
- **License:** MIT
- **Platforms:** native SwiftUI iOS 18+ (iPhone, iPad, iPhone Duo) and a full web app. Phone and browser players share the same rooms.
- **Identity:** guest play with a 6-character room code and a nickname (no account), **or** optional sign-in with the existing Yoink Labs Clerk instance used by Wanderer, Split, and yoinklabs.dev.
- **Realtime:** a Cloudflare Worker with one Durable Object per room, over WebSockets
- **Media:** photos and 5–8 second video clips, uploaded only for the active game and deleted when each round ends

The architecture, gameplay, auth model, media pipeline, and conventions are in [docs/SPEC.md](docs/SPEC.md).

## Play

1. Create a room, or join with a code, QR code, or share link (`https://flashback.yoinklabs.dev/join/ABC234`) and a nickname.
2. The host picks rounds, timer, and **Photos**, **Videos**, or **Both**.
3. Everyone adds at least one photo or video and readies up. The host starts when all players are ready (2 or more, up to 12).
4. Each round shows one random item from someone's pool: a photo, or a muted looping clip you can unmute. Guess whose it is.
5. See the reveal and scores, then a final podium. Play again in the same room.

### Scoring

A correct guess earns **500** for accuracy, up to **500** for speed (`round(500 × time left ÷ round time)`), and **100 per previous consecutive correct guess** (capped at 500). Wrong, late, and missing guesses earn 0 and reset the streak. The owner sits their round out. Ties: rounds rank earlier guesses first; the podium ranks less total time on correct guesses first, then join order. The server computes scores (`worker/src/scoring.ts`); iOS mirrors the formula for hints (`Flashback/Core/Scoring.swift`), and both are tested against the same cases.

## How sign-in works

Both ways in work on web and iOS, in the same room:

- **Guest:** `POST /v1/rooms` or `POST /v1/rooms/:code/join` with `{ "nickname": "Sam" }` and no `Authorization` header. Nicknames are 1–24 visible characters after trimming and unique in the room, ignoring case.
- **Signed in:** the same calls with `Authorization: Bearer <Clerk session token>`. The Worker verifies RS256 tokens with `jose` against `https://clerk.yoinklabs.dev/.well-known/jwks.json`, requires `exp`, `sub`, and `iat`, and checks `azp` (`validParty`, as in Split) against `https://flashback.yoinklabs.dev`, `com.yoinklabs.flashback`, and the shared yoinklabs.dev origins. Signed-in players keep the same seat when they rejoin.

Either way, the room returns a **room session token**: an HS256 JWT signed with a random key that exists only inside that room's Durable Object. It names one room, one player id, and one nickname, lasts 4 hours (refreshed over the socket in long games), and dies with the room. Web keeps it in `localStorage`; iOS keeps it in the Keychain. Guests never become Clerk users and no email or phone is collected.

Every authenticated call (WebSocket, upload, media, leave) accepts **either** a Clerk token or a room session token. Browsers send the token as a WebSocket subprotocol (`flashback.v1, auth.<token>`) because they cannot set headers on WebSockets; iOS does the same. No Clerk secret key is needed for gameplay or tests.

## Media and privacy

- **iOS:** "Pick for me" chooses random photos and videos with PhotoKit (full or limited access), or players choose with the system photo picker (no permission needed). Photos become a ≤1600 px JPEG with no metadata. Videos become a random 6-second H.264 MP4 clip (≤8 MB, metadata stripped) via `AVAssetExportSession`. Originals and library identifiers never leave the phone.
- **Web:** photos are decoded, resized, and re-encoded as JPEG (dropping EXIF/GPS). Videos are trimmed and re-encoded in the browser with WebCodecs and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) to the same clip format. If a browser cannot do that, it says so and uploads nothing.
- **Server:** accepts only JPEG (≤3 MB, EXIF/XMP/comments stripped again) and H.264 MP4 (≤8 MB, 1–8 s, checked by reading the MP4 boxes). Up to 10 items per player per game.
- **Storage:** R2 keys are `rooms/<code>/<room instance>/g<game>/<random id>`. During a reveal, players fetch the round's item from a 256-bit capability URL that also needs their session, and only while the reveal lasts. Media is deleted when its round ends, when the game ends (unused items), when its owner leaves, and when the room closes. A 2-hour TTL alarm in the Durable Object is a backstop. Nothing is written to D1, and logs never contain media or media URLs.
- Rooms close 2 minutes after everyone disconnects, 15 minutes after a finished game, or after an hour idle in the lobby. Dropped players keep their seat for 90 seconds. If the host leaves or drops, the longest-present player becomes host.

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

## Deploying later

Nothing is deployed yet. One-time setup, in order, when approved:

1. **R2:** create the `flashback-media` bucket in the Yoink Labs Cloudflare account (`2bc9c3c136a62ea9dcbddaa6f59edca4`). Add a lifecycle rule deleting objects under `rooms/` after 1 day as a second backstop.
2. **Worker:** `npm run build --prefix web && npm run deploy --prefix worker` (Worker `flashback`, Durable Object class `Room` with SQLite storage, free plan).
3. **DNS / route:** add `flashback.yoinklabs.dev` as a custom domain for the Worker (`routes` in `worker/wrangler.jsonc`).
4. **Clerk:** add `https://flashback.yoinklabs.dev` as an allowed origin and the iOS app (`com.yoinklabs.flashback`) as a native application on the shared instance. This is a careful, approved change; do not touch existing OAuth or redirect settings.
5. **Apple:** create the App Store Connect app and register `com.yoinklabs.flashback` with Sign in with Apple and Associated Domains (`applinks:flashback.yoinklabs.dev`). The Worker already serves `/.well-known/apple-app-site-association`.

Optional: `wrangler secret put CLERK_SECRET_KEY` for future admin or QA tooling. Gameplay never needs it.
