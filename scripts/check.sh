#!/bin/bash
# Runs every check CI runs. Leaves the system default Xcode alone: iOS steps use
# Xcode 27.2 through DEVELOPER_DIR (override FLASHBACK_XCODE to point elsewhere).
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --prefix web
npm run typecheck --prefix web
npm run check:auth --prefix web
npm run build --prefix web
npm test --prefix web
npm ci --prefix worker
npm run typecheck --prefix worker
npm test --prefix worker
export DEVELOPER_DIR="${FLASHBACK_XCODE:-/Applications/Xcode-27.2.0.app/Contents/Developer}"
xcodegen generate
xcodebuild test -project Flashback.xcodeproj -scheme Flashback \
  -destination "${FLASHBACK_DESTINATION:-platform=iOS Simulator,name=iPhone 17,OS=27.2}" \
  -derivedDataPath .ade/cache/ios-simulator/DerivedData \
  OTHER_CODE_SIGN_FLAGS=--strip-disallowed-xattrs
