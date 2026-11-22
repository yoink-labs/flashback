#!/bin/bash
# Prepare (and, only with --submit, send) Flashback's App Store submission
# with the tip in-app purchases, using the `asc` CLI (App Store Connect API key
# from the saved default profile; nothing secret is printed).
#
#   scripts/submit-appstore-tips.sh            # dry run (default): plan + readiness, changes nothing
#   scripts/submit-appstore-tips.sh --submit   # apply the plan and submit for App Review
#
# The plan:
#   1. Reuse the editable App Store version (or create one) with the same
#      marketing version as project.yml. Never bumps the marketing version;
#      an editable placeholder with another version string is renamed to it.
#   2. Attach the newest VALID, unexpired build of that marketing version.
#   3. Add every READY_TO_SUBMIT dev.yoinklabs.flashback.tip.* consumable
#      (its IAP version) to the same review submission.
#   4. Submit. --submit refuses to run while `asc validate` reports blockers.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ID="${FLASHBACK_ASC_APP_ID:-6837154899}"
TIP_PREFIX="dev.yoinklabs.flashback.tip."
MODE="dry-run"
case "${1:-}" in
  ""|--dry-run) MODE="dry-run" ;;
  --submit) MODE="submit" ;;
  -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
  *) echo "Unknown option: $1 (use --dry-run or --submit)" >&2; exit 2 ;;
esac

command -v asc >/dev/null || { echo "asc CLI not found" >&2; exit 1; }
MARKETING=$(sed -n "s/^ *MARKETING_VERSION: *'\{0,1\}\([^']*\)'\{0,1\} *$/\1/p" project.yml | head -1)
[ -n "$MARKETING" ] || { echo "MARKETING_VERSION not found in project.yml" >&2; exit 1; }

json() { python3 -I -c "$1"; }
say() { printf '%s\n' "$*"; }
step() { if [ "$MODE" = submit ]; then say "  -> $*"; else say "  [dry-run] would: $*"; fi; }

say "Flashback App Store submission ($MODE)"
say "App: $APP_ID   marketing version (project.yml): $MARKETING"
say

# 1. App Store version ---------------------------------------------------------
VERSIONS=$(asc versions list --app "$APP_ID" --platform IOS --output json)
read -r VERSION_ID VERSION_STRING VERSION_STATE < <(printf '%s' "$VERSIONS" | json '
import json, sys
editable = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"}
rows = json.load(sys.stdin).get("data", [])
pick = None
for v in rows:
    a = v["attributes"]
    state = a.get("appVersionState") or a.get("appStoreState")
    if state in editable:
        pick = (v["id"], a.get("versionString"), state)
        if a.get("versionString") == "'"$MARKETING"'":
            break
print(*(pick or ("-", "-", "-")))
')
say "1. App Store version"
if [ "$VERSION_ID" = "-" ]; then
  say "   none editable"
  step "create App Store version $MARKETING (IOS)"
elif [ "$VERSION_STRING" != "$MARKETING" ]; then
  say "   editable version $VERSION_STRING ($VERSION_STATE, id $VERSION_ID)"
  step "rename its version string $VERSION_STRING -> $MARKETING to match the binaries (no marketing-version bump)"
else
  say "   reuse $VERSION_STRING ($VERSION_STATE, id $VERSION_ID)"
fi

# 2. Build -------------------------------------------------------------------
BUILDS=$(asc builds list --app "$APP_ID" --version "$MARKETING" --processing-state all --exclude-expired --limit 50 --output json)
read -r BUILD_ID BUILD_NUMBER BUILD_STATE < <(printf '%s' "$BUILDS" | json '
import json, sys
rows = [b for b in json.load(sys.stdin).get("data", [])
        if b["attributes"].get("processingState") == "VALID" and not b["attributes"].get("expired")]
rows.sort(key=lambda b: int(b["attributes"].get("version") or 0), reverse=True)
b = rows[0] if rows else None
print(*( (b["id"], b["attributes"]["version"], b["attributes"]["processingState"]) if b else ("-", "-", "-") ))
')
say "2. Build"
if [ "$BUILD_ID" = "-" ]; then
  say "   BLOCKER: no VALID, unexpired build of $MARKETING (still processing? check: asc builds list --app $APP_ID)"
else
  say "   newest valid build: $MARKETING ($BUILD_NUMBER), id $BUILD_ID"
  step "attach build $BUILD_NUMBER to the version"
fi

# 3. Tip IAPs ----------------------------------------------------------------
IAPS=$(asc iap list --app "$APP_ID" --paginate --output json)
TIP_ROWS=$(printf '%s' "$IAPS" | json '
import json, sys
for i in json.load(sys.stdin).get("data", []):
    a = i["attributes"]
    if a.get("productId", "").startswith("'"$TIP_PREFIX"'"):
        print(i["id"], a.get("productId"), a.get("inAppPurchaseType"), a.get("state"))
' | sort -k2)
say "3. Tip in-app purchases"
READY_IAPS=()
while read -r iap_id product type state; do
  [ -n "${iap_id:-}" ] || continue
  if [ "$type" = CONSUMABLE ] && [ "$state" = READY_TO_SUBMIT ]; then
    READY_IAPS+=("$iap_id")
    say "   ready  $product ($iap_id)"
  else
    say "   skip   $product ($type, $state)"
  fi
done <<< "$TIP_ROWS"
[ ${#READY_IAPS[@]} -gt 0 ] && step "add ${#READY_IAPS[@]} tip IAP version(s) to the review submission"

# 4. Readiness -----------------------------------------------------------------
say "4. Readiness (asc validate)"
BLOCKERS=0
if [ "$VERSION_ID" != "-" ]; then
  REPORT=$(asc validate --app "$APP_ID" --version-id "$VERSION_ID" --output json 2>/dev/null || true)
  # A missing build is expected before step 2 runs; everything else blocks.
  # Details go to stderr; the count of blockers to stdout.
  BLOCKERS=$(printf '%s' "$REPORT" | json '
import collections, json, sys
try:
    steps = json.load(sys.stdin).get("remediation", {}).get("steps", [])
except Exception:
    print(-1); sys.exit()
out = [s for s in steps if s.get("blocking") and s.get("checkId") != "build.required.missing"]
groups = collections.OrderedDict()
for s in out:
    key = "age_rating" if s["checkId"].startswith("age_rating") else s["checkId"]
    groups.setdefault(key, []).append(s)
for key, items in groups.items():
    s = items[0]
    extra = " (%d fields)" % len(items) if len(items) > 1 else ""
    print("   BLOCKER %s%s: %s -> %s" % (key, extra, s["message"], s.get("remediation", "")), file=sys.stderr)
for s in steps:
    if s.get("severity") == "warning" and not s["checkId"].startswith("iap.review_readiness"):
        print("   warning %s: %s" % (s["checkId"], s["message"]), file=sys.stderr)
    if s.get("severity") == "info":
        print("   info    %s: %s" % (s["checkId"], s["message"]), file=sys.stderr)
print(len(out))
')
  [ "$BLOCKERS" = "-1" ] && { say "   could not read asc validate output"; BLOCKERS=1; }
  [ "$BUILD_ID" = "-" ] && BLOCKERS=$((BLOCKERS + 1))
  [ "$VERSION_STRING" != "$MARKETING" ] && say "   note: validation ran against version $VERSION_STRING before the rename"
else
  say "   (no version yet; validation runs after it is created)"
fi
say "   blocking issues: $BLOCKERS"
say

if [ "$MODE" = dry-run ]; then
  if [ "$BLOCKERS" -eq 0 ]; then
    say "Ready. Run: scripts/submit-appstore-tips.sh --submit"
  else
    say "Not ready: fix the blockers above, then run --submit."
  fi
  exit 0
fi

# --submit -------------------------------------------------------------------
[ "$BLOCKERS" -eq 0 ] || { say "Refusing to submit with $BLOCKERS blocking issue(s)."; exit 1; }
[ "$BUILD_ID" != "-" ] || { say "No build to attach."; exit 1; }

if [ "$VERSION_ID" = "-" ]; then
  VERSION_ID=$(asc versions create --app "$APP_ID" --platform IOS --version "$MARKETING" --release-type MANUAL --output json \
    | json 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
elif [ "$VERSION_STRING" != "$MARKETING" ]; then
  asc versions update --version-id "$VERSION_ID" --version "$MARKETING" --output json >/dev/null
fi
asc versions attach-build --version-id "$VERSION_ID" --build-id "$BUILD_ID" --output json >/dev/null

SUBMISSION_ID=$(asc review submissions-create --app "$APP_ID" --platform IOS --output json \
  | json 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
asc review items add --submission "$SUBMISSION_ID" --item-type appStoreVersions --item-id "$VERSION_ID" --if-exists skip --output json >/dev/null
for iap_id in "${READY_IAPS[@]}"; do
  IAP_VERSION=$(asc iap versions list --iap-id "$iap_id" --output json | json '
import json, sys
rows = json.load(sys.stdin).get("data", [])
rows.sort(key=lambda v: v["attributes"].get("version") or 0, reverse=True)
print(rows[0]["id"] if rows else "-")')
  [ "$IAP_VERSION" != "-" ] || { say "No IAP version for $iap_id"; exit 1; }
  asc review items add --submission "$SUBMISSION_ID" --item-type inAppPurchaseVersions --item-id "$IAP_VERSION" --if-exists skip --output json >/dev/null
done
asc review submissions-submit --id "$SUBMISSION_ID" --confirm --output json >/dev/null
say "Submitted: version $MARKETING ($BUILD_NUMBER) with ${#READY_IAPS[@]} tip IAP(s); review submission $SUBMISSION_ID"
