# Flashback design spec (v2)

This replaces the "UI/UX direction" section of `docs/MILESTONE2.md`. Web and iOS
must look like the same product. If something here conflicts with what is in
the code, this wins.

## What went wrong in v1 (do not repeat)

- Every section was a bordered card with a title and an ALL-CAPS label. That is
  the generic template look. **No stacked boxes.** Content sits directly on the
  background; use a surface only where it groups something you tap.
- Gradient text and gradient buttons everywhere. **No gradient text. No
  gradient buttons.** One accent colour.
- Explanatory paragraphs and repeated privacy notes. **Say each thing once, in
  as few words as possible.** If a screen needs a paragraph to explain itself,
  the layout is wrong.
- Controls overlaid on photos, cryptic counters ("3 · 1 ▸"), duplicate
  information (room code twice, "Added 4" and "4 ready").
- Empty, unbalanced space (Join screen, wide reveal).

## Principles

1. **The photo is the hero.** Media fills the screen edge to edge during the
   reveal. Everything else gets out of its way.
2. **Players are the colour.** Each player has a vivid colour (join order). The
   UI chrome is neutral; colour comes from avatars and the one accent.
3. **One primary action per screen**, always in the bottom thumb zone, full width
   on phones.
4. **Almost no copy.** Labels are 1–3 words. Status is one short line.
5. **Big, confident type** for the moments that matter (room code, countdown,
   "It was Sam's", the winner). Everything else is quiet.

## Tokens

Colours (dark only):

| token | value | use |
| --- | --- | --- |
| bg | `#0E0D12` | page background, flat (no radial gradients) |
| surface | `#1A1820` | grouped tappable things (tiles, rows) |
| surface-2 | `#24212C` | pressed/selected surface, inputs |
| line | `#2C2935` | hairlines only where needed |
| text | `#F5F4F7` | primary text |
| text-2 | `#9C98A8` | secondary text |
| text-3 | `#6B6777` | tertiary / disabled |
| accent | `#FF4F64` | the ONE accent: primary button fill, focus, selected state |
| good | `#3DDC97` | correct |
| bad | `#FF6B6B` | wrong (use sparingly) |
| gold | `#FFC94A` | winner / rank 1 only |

Player colours by join order: `#FF6B6B #FFB547 #FFE066 #6BE675 #2EE5C5 #4FC3FF #7C8CFF #B07CFF #FF7AD9 #FF9A5A #B7E34A #D9D6E0`.

Type: SF Pro Rounded on iOS, `ui-rounded, "SF Pro Rounded", system-ui` on web.

| role | size / weight |
| --- | --- |
| hero (room code, countdown digit) | 64–120, black (900), tracking +2 for codes, tabular digits |
| title | 28, heavy (800) |
| headline | 20, bold |
| body | 17, regular/medium |
| caption | 13, semibold, text-2 |

No ALL-CAPS labels anywhere except the room code itself.

Spacing on a 4-pt grid: page padding 20 (phone) / 32 (wide), section gap 28,
row height ≥ 56, tile gap 3. Radius: 14 for tiles and rows, 18 for media, full
capsule for buttons.

Buttons: height 56, full width on phones, max 360 on wide.
- **Primary:** solid accent fill, white text, bold 17. Disabled: surface-2 fill,
  text-3 text (no faded gradient).
- **Secondary:** surface fill, text colour.
- **Text button:** text-2, no fill.

Avatars: circle in the player colour, initial in `#0E0D12`, heavy. Sizes 28 /
40 / 56 / 88. A "ready" avatar has a 3-pt good-colour ring. Offline: 40% opacity.

Motion: 0.25 s spring for state changes; countdown digit scales 1.25→1 each
second; reveal fades in from 0.96 scale; points count up in 0.6 s. Respect
Reduce Motion (fade only).

## Screens

### 1. Home

Vertically centred group, phone:

```
        [fanned photo stack graphic]   ← 3 rounded rectangles (120×150), rotated
                                          -8°, 0°, +8°, filled with 3 player
                                          colours at 90% and a white 4-pt border,
                                          like polaroids. Pure shapes, no images.
        Flashback                       ← title 40 heavy, white. NOT gradient.
        Whose camera roll is it?        ← body 17, text-2

        [ Your name            ]        ← single input, surface-2, 56 tall
        [      Host a game      ]       ← primary
        [     Join with code    ]       ← secondary

        Free · no account · nothing is kept   ← caption, text-3, bottom of screen
```

- Sign-in (iOS/web Clerk) becomes a small text button top-right: "Sign in" /
  the account name. Not a line of explanatory text.
- Remembered name is prefilled. Host/Join disabled until a valid name.
- On iOS the keyboard must never cover Host/Join (scroll them into view).

### 2. Join

```
  ←  Join a game                         ← back button + title 28
                                          
     [ A ][ B ][ 2 ][ 3 ][ 4 ][   ]       ← 6 boxes, each 48×60, surface-2,
                                            hero digits 28 heavy; focused box
                                            has accent 2-pt border; NO dots.
                                            Autofocus, paste fills all.

  (when 6 chars entered, below, animated in:)
     ┌──────────────────────────────┐
     │ (S) Sam's room               │      ← avatar 40 + headline
     │ 4 players · Mix · 10 rounds  │      ← caption
     └──────────────────────────────┘
     [ Your name            ]            ← prefilled
     [         Join          ]           ← primary, bottom
```

Errors as one red caption under the boxes ("No room with that code").
The empty screen before a code is typed is fine because the keyboard fills the
bottom half.

### 3. Lobby (the screen people stare at most)

Phone, top to bottom, no cards:

```
  ✕                                     ← leave (icon button, top-left)
          ABC 234                       ← room code, hero 56 black, tracking
     [ Share invite ]  [ QR ]           ← two small secondary capsules, centred

  (R)(S)(T)(  +  )                       ← player row: avatar 56 + name caption
                                            under each, horizontal scroll if many;
                                            ready = good ring; host = small crown
                                            on avatar; last slot is a dashed
                                            "+" circle that opens Share.

  Your deck · 22 of 24                  ← headline + caption ("of" = unhidden of total)
  ┌──┬──┬──┐
  │  │  │  │                            ← edge-to-edge square grid, 3 columns
  ├──┼──┼──┤                               phone / 5 tablet / 6 wide, gap 3,
  │  │░░│  │                               radius 0 inside, 14 on the grid's
  └──┴──┴──┘                               outer corners. Videos: small ▶ 0:06
                                            bottom-left. TAP = hide/unhide
                                            (hidden: 25% opacity + eye-slash
                                            centred). LONG-PRESS (iOS) / ⋯ hover
                                            button (web) = preview.
  [ Shuffle ]  [ Add… ]                 ← two secondary capsules under the grid

  Mix · 10 rounds · 20s           ›     ← ONE settings row (surface, 56 tall).
                                            Host: opens a sheet. Others: no
                                            chevron, read-only.

  ────────────── sticky bottom ──────────────
  Waiting for Robo                      ← caption, text-2, centred (blocker)
  [          Ready           ]          ← primary (guests)  /  "I'm ready ✓" = secondary when ready
  [       Start game          ]         ← primary (host), disabled until no blocker
```

- **The host never presses Ready.** Pressing Start counts as ready (server rule).
  The host sees only Start.
- No rules paragraph, no privacy paragraph. The only privacy line in the whole
  lobby is the deck caption on first use: "Only the photo picked each round is
  sent." shown under an EMPTY deck (empty state), nowhere else.
- Empty deck state: large dashed area the size of 2 grid rows, centred icon +
  "Add photos & videos" (web: click or drop; iOS: "Shuffle from my library"
  primary-ish + "Choose…" text button).
- The sticky bar must not cover content: add bottom padding equal to its height.
- Room code shows ONCE (no header pill).

Settings sheet (host):
```
  Game settings                     Done
  Show   [ Photos | Videos | Mix ]        ← segmented, accent selected
  Rounds        (–)  10  (+)
  Timer   [10] [20] [30] [45] [60]        ← chips, accent selected
```

Wide (≥ 900 web, Duo open, iPad): two columns. Left 380 wide: code, share,
players as a vertical list (avatar 40, name, ready ring), settings row, sticky
button at the bottom of this column. Right: deck grid fills the rest, 5–6
columns. No empty right half.

### 4. Countdown

Full screen, centred:
```
        Round 3 of 10            ← caption text-2
            2                    ← hero 120 black, white, scale pulse
```
While waiting for the upload: replace the digit with three small cards
shuffling (the Home polaroid graphic, animated) and the caption "Shuffling…".
Nothing else. No "Get ready to guess…".

### 5. Reveal

Phone:
```
  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔         ← 4-pt timer bar at the very top, accent→ fades;
                                       last 5 s turns bad colour
  ┌──────────────────────────┐
  │                          │
  │        MEDIA             │     ← fills width edge to edge, max 58% of
  │                          │        height, aspect FILL for photos up to the
  │                     🔇   │        box (crop is fine), radius 0 on phone.
  └──────────────────────────┘        Mute: 40-pt circle, bottom-right, 50% black.
   3/10                    12        ← caption row: round left, seconds right (tabular)
  Whose is it?                      ← title 28
  (R)  (S)  (T)  (U)                ← avatar 56 + name caption under, 4 per row,
  Robo  Sam  You  Uma                   NO boxes around them. "You" for yourself.
```
- Tap an avatar → it scales up with an accent ring, others drop to 35% opacity,
  title changes to "Locked in", and a caption "3 of 5 guessed" appears. Haptic.
- Wide (Duo open, landscape, ≥ 900 web): media on the left filling the full
  height (radius 18, 20 margin), right column 360 wide, vertically centred:
  round/seconds, "Whose is it?", avatar grid 3 per row. No empty quadrants.
- Photo letterboxing: on phone, photos use aspect FILL in the media box; on wide,
  aspect FIT on bg colour.

### 6. Results

One list, no separate "guesses" and "standings" boxes.

```
              (R)                ← owner avatar 88 with a gold ring
          It was Robo's          ← title 28; name in the owner's colour
          +956 · 2 in a row      ← your outcome: good colour if right,
                                    text-2 "Missed it" if wrong,
                                    text-2 "Yours. Nobody knew 😉" if owner.
       [ small media 96×96 ]     ← radius 14

   1  (W) You        →(R) ✓   +956   1,412  ↑1
   2  (S) Sam        →(T) ✗           880   ↓1
   3  (R) Robo  owner                 610
                                  ← rows 56 tall on surface, radius 14, gap 6.
                                    Columns: rank, avatar 40, name, mini avatar
                                    of who they picked + ✓/✗, points delta (good),
                                    total (bold), movement arrow (good/bad/none).
                                    Owner row says "owner" in text-3, no delta.
  [         Next          ]      ← host only, primary. Guests: caption
                                    "Next round in 5" counting down.
```

### 7. Podium

```
          Robo wins!               ← title 32 (or "You win!"), confetti once
     (S)        (R)        (T)      ← podium ORDER 2 – 1 – 3, winner centred
     880       1,412       610         and tallest; blocks are surface colour
    ┌───┐     ┌───┐     ┌───┐         with the rank number in text-3, winner's
    │ 2 │     │ 1 │     │ 3 │         block has a gold top edge. Avatars 56/88/56.
  ────────────────────────────
   4  (U) Uma        420           ← remaining players, compact rows
  [       Play again        ]      ← host primary
  [          Leave          ]      ← text button
```

## Checklist before handing in (screenshot every one)

Web at 390×844 and 1280×800; iOS on iPhone Duo folded (cover) and unfolded,
plus one regular iPhone:
Home, Home with keyboard (iOS), Join empty, Join with preview, Lobby host empty
deck, Lobby host with deck + 2 players, Lobby guest ready, settings sheet,
Countdown, Shuffling, Reveal photo, Reveal video, Reveal locked in, Results
(you right / you wrong / you owner), Podium.

For each: no text overlapping media or controls, nothing hidden behind the
sticky bar, no duplicated info, no ALL-CAPS labels, no gradients, primary
action in the bottom thumb zone, balanced empty space.
