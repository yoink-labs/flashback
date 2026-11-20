# Flashback by Yoink Labs

A free, open-source [Photo Roulette](https://photoroulette.app) party game with **full photo and video support**. No paywall or Pro tier.

- **Name:** Flashback · planned bundle `com.yoinklabs.flashback`
- **License:** MIT
- **Platforms:** native SwiftUI iOS 18+ and a full web app, so phone and browser players can be in the same room
- **Identity:** the existing Yoink Labs production Clerk instance used by Wanderer, Split, and yoinklabs.dev — **plus guest play**. Friends can jump into a room with a 6-character room code and a nickname, with no account required.
- **Realtime:** Cloudflare Workers and Durable Objects over WebSockets
- **Media:** photos and short videos, uploaded only for the active game and deleted when the round or game ends

The architecture, gameplay, auth model (Clerk and guests), media pipeline, and stack conventions are in [docs/SPEC.md](docs/SPEC.md). Milestone 1 (Worker + Durable Objects, web app, native iOS app, tests, and CI) is being built from that spec.

## Play (planned)

1. Create a room, or join with a code / share link and a nickname.
2. Pick photos, videos, or both. Ready up.
3. Each round reveals a random photo or a short looping video from one player's library.
4. Guess who it belongs to. Speed, accuracy, and streaks score points.
5. See the reveal, then a final podium, and play again.

## Development

The first implementation is in progress. The intended layout and commands match Split:

```sh
# Web and Worker
npm ci --prefix worker
npm ci --prefix web
npm test --prefix worker
npm run typecheck --prefix worker
npm run build --prefix web

# iOS (Xcode 27 / iOS 27 SDK; leave the system default Xcode alone)
xcodegen generate
DEVELOPER_DIR=/Applications/Xcode-27.2.0.app/Contents/Developer xcodebuild test \
  -project Flashback.xcodeproj -scheme Flashback \
  -destination 'platform=iOS Simulator,name=iPhone 17,OS=27.2'
```

Use this project's ADE secrets for any deploy later. Never put secrets in source, logs, or `.env` files. Do not change Clerk OAuth settings or Wanderer's shared sign-in setup; reuse the existing publishable key, issuer, and JWKS.

Planned public URLs (not provisioned yet): `https://flashback.yoinklabs.dev` and a Worker API host on `yoinklabs.dev`.
