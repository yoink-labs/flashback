import SwiftUI
import XCTest
@testable import Flashback

/// Milestone 4 (docs/MILESTONE4.md): decoding with defaults for old servers,
/// the new client messages, server-sized bunches, effect maths, results
/// breakdowns, shop availability, and the lobby chips.
final class ArcadeDecodingTests: XCTestCase {
    static let arcadeJSON = #"""
    {"type":"state","state":{"code":"ABC234","phase":"reveal","game":2,"hostID":"g_1","capacity":12,
    "settings":{"rounds":10,"timerSeconds":20,"mediaMode":"both","breakSeconds":7,"swaps":3,"evenSplit":true,
      "effects":{"greyscale":{"enabled":true,"trigger":"wrong","after":4},
                 "blur":{"enabled":true,"trigger":"right","after":5,"strength":"heavy"},
                 "focus":{"enabled":true,"frequency":"half","span":75},
                 "zoom":{"enabled":true,"frequency":"every","span":25,"scale":2}},
      "powerups":{"fiftyFifty":{"enabled":true,"after":4},"shop":{"enabled":true}}},
    "serverNow":1700000000000,"phaseEndsAt":1700000020000,"startBlocker":null,
    "bunch":{"photos":5,"videos":2},
    "players":[
      {"id":"g_1","nickname":"Host","signedIn":false,"isHost":true,"ready":true,"connected":true,"score":760,"streak":2,
       "deck":{"photos":5,"videos":2},"items":{"doubleDown":1,"shield":1,"fiftyFifty":2}},
      {"id":"u_2","nickname":"Cal","signedIn":true,"isHost":false,"ready":true,"connected":true,"score":400,"streak":0,
       "deck":{"photos":5,"videos":2},"items":{"doubleDown":0,"shield":1,"fiftyFifty":0}}],
    "you":{"id":"g_1"},
    "round":{"index":2,"total":10,"kind":"photo","revealAt":1700000000000,"endsAt":1700000020000,
      "canGuess":true,"yourGuess":null,"guessedCount":0,"guesserCount":2,
      "yourEffect":{"kind":"blur","strength":"light","trigger":"wrong","streak":5},
      "effect":{"kind":"zoom","spanMs":6000,"scale":3,"originX":0.3,"originY":0.7},
      "eliminated":["u_2"]},
    "lastResult":{"index":1,"ownerID":"u_2","kind":"photo","rows":[
      {"playerID":"g_1","targetID":"u_2","correct":true,"points":760,"accuracy":500,"speed":140,"streakBonus":100,
       "streak":2,"elapsedMs":4200,"total":760,"bonus":120,"doubleDown":"won","shielded":false,
       "effect":"blur","roundEffect":"focus","fiftyFifty":true,"earnedFiftyFifty":true}]},
    "podium":[],
    "shop":{"open":true,"bought":false,"prices":{"doubleDown":250,"shield":200,"fiftyFifty":400}}}}
    """#

    private func decode(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    private func encode(_ message: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func encodeString(_ message: ClientMessage) throws -> String {
        let data = try JSONEncoder().encode(message)
        let object = try JSONSerialization.jsonObject(with: data)
        let sorted = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
        return try XCTUnwrap(String(data: sorted, encoding: .utf8))
    }

    func testDecodesTheFullMilestone4View() throws {
        let view = try XCTUnwrap(decode(Self.arcadeJSON).state)
        XCTAssertTrue(view.settings.evenSplit)
        XCTAssertEqual(view.settings.effects.greyscale.trigger, .wrong)
        XCTAssertEqual(view.settings.effects.blur.strength, .heavy)
        XCTAssertEqual(view.settings.effects.focus.span, 75)
        XCTAssertEqual(view.settings.effects.zoom.scale, 2)
        XCTAssertTrue(view.settings.powerups.fiftyFifty.enabled)
        XCTAssertEqual(view.settings.powerups.fiftyFifty.after, 4)
        XCTAssertTrue(view.settings.powerups.shop.enabled)
        XCTAssertEqual(view.bunch, BunchRequirement(photos: 5, videos: 2))
        XCTAssertEqual(view.me?.items, PlayerItems(doubleDown: 1, shield: 1, fiftyFifty: 2))
        XCTAssertEqual(view.players[1].items, PlayerItems(shield: 1))
        XCTAssertEqual(view.round?.yourEffect?.kind, .blur)
        XCTAssertEqual(view.round?.yourEffect?.strength, .light)
        XCTAssertEqual(view.round?.yourEffect?.streak, 5)
        XCTAssertEqual(view.round?.effect?.kind, .zoom)
        XCTAssertEqual(view.round?.effect?.spanMs, 6000)
        XCTAssertEqual(view.round?.effect?.origin, CGPoint(x: 0.3, y: 0.7))
        XCTAssertEqual(view.round?.eliminated, ["u_2"])
        let row = try XCTUnwrap(view.lastResult?.rows.first)
        XCTAssertEqual(row.bonus, 120)
        XCTAssertEqual(row.doubleDown, .won)
        XCTAssertEqual(row.effect, .blur)
        XCTAssertEqual(row.roundEffect, .focus)
        XCTAssertTrue(row.fiftyFifty)
        XCTAssertTrue(row.earnedFiftyFifty)
        let shop = try XCTUnwrap(view.activeShop)
        XCTAssertTrue(shop.open)
        XCTAssertFalse(shop.bought)
        XCTAssertEqual(shop.prices.fiftyFifty, 400)
    }

    func testOldServerDecodesEveryNewFieldAsADefault() throws {
        let view = try XCTUnwrap(decode(RoomStateTests.revealJSON).state)
        XCTAssertFalse(view.settings.evenSplit)
        XCTAssertEqual(view.settings.effects, .defaults)
        XCTAssertEqual(view.settings.powerups, .defaults)
        XCTAssertEqual(view.bunch, .defaults)
        XCTAssertEqual(view.bunch, BunchRequirement(photos: 12, videos: 6))
        XCTAssertEqual(view.me?.items, PlayerItems.none)
        XCTAssertNil(view.round?.yourEffect)
        XCTAssertNil(view.round?.effect)
        XCTAssertEqual(view.round?.eliminated, [])
        XCTAssertNil(view.activeShop)
    }

    func testShopCanArriveOnTheRound() throws {
        let json = Self.arcadeJSON
            .replacingOccurrences(of: #""shop":{"open":true,"bought":false,"prices":{"doubleDown":250,"shield":200,"fiftyFifty":400}}"#, with: #""shop":null"#)
            .replacingOccurrences(of: #""eliminated":["u_2"]}"#, with: #""eliminated":["u_2"],"shop":{"open":true,"bought":true,"prices":{}}}"#)
        let view = try XCTUnwrap(decode(json).state)
        let shop = try XCTUnwrap(view.activeShop)
        XCTAssertTrue(shop.open)
        XCTAssertTrue(shop.bought)
        // Missing prices decode as the defaults.
        XCTAssertEqual(shop.prices, .defaults)
    }

    func testEncodesTheMilestone4ClientMessages() throws {
        XCTAssertEqual(try encodeString(.useFiftyFifty), #"{"type":"useFiftyFifty"}"#)
        XCTAssertEqual(try encodeString(.buy(.doubleDown)), #"{"item":"doubleDown","type":"buy"}"#)
        XCTAssertEqual(try encodeString(.settings(evenSplit: true)), #"{"evenSplit":true,"type":"settings"}"#)
        XCTAssertEqual(try encodeString(.settings(evenSplit: false)), #"{"evenSplit":false,"type":"settings"}"#)

        let effects = EffectsSettings(
            greyscale: GreyscaleSettings(enabled: true, trigger: .wrong, after: 4),
            blur: BlurSettings(enabled: true, trigger: .right, after: 6, strength: .light),
            focus: FocusSettings(enabled: true, frequency: .half, span: 75),
            zoom: ZoomSettings(enabled: true, frequency: .every, span: 25, scale: 3)
        )
        let powerups = PowerupSettings(
            fiftyFifty: FiftyFiftySettings(enabled: true, after: 6),
            shop: ShopSettings(enabled: true)
        )
        let settings = try encode(.settings(effects: effects, powerups: powerups))
        XCTAssertEqual(settings["type"] as? String, "settings")
        let effectsJSON = try XCTUnwrap(settings["effects"] as? [String: Any])
        XCTAssertEqual((effectsJSON["greyscale"] as? [String: Any])?["trigger"] as? String, "wrong")
        XCTAssertEqual((effectsJSON["blur"] as? [String: Any])?["strength"] as? String, "light")
        XCTAssertEqual((effectsJSON["focus"] as? [String: Any])?["span"] as? Int, 75)
        XCTAssertEqual((effectsJSON["zoom"] as? [String: Any])?["scale"] as? Int, 3)
        let powerupsJSON = try XCTUnwrap(settings["powerups"] as? [String: Any])
        XCTAssertEqual((powerupsJSON["fiftyFifty"] as? [String: Any])?["after"] as? Int, 6)
        XCTAssertEqual((powerupsJSON["shop"] as? [String: Any])?["enabled"] as? Bool, true)
    }

    func testSettingsValidateTheBlurAfterGreyscaleRule() {
        var effects = EffectsSettings(
            greyscale: GreyscaleSettings(enabled: true, trigger: .right, after: 5),
            blur: BlurSettings(enabled: true, trigger: .right, after: 5, strength: .medium)
        )
        XCTAssertTrue(effects.needsBlurAfterGreyscale)
        XCTAssertEqual(effects.validated().blur.after, 6)

        // The top of the range: greyscale moves down so blur can start after it.
        effects.greyscale.after = 10
        effects.blur.after = 10
        let top = effects.validated()
        XCTAssertEqual(top.greyscale.after, 9)
        XCTAssertEqual(top.blur.after, 10)
        XCTAssertFalse(top.needsBlurAfterGreyscale)

        // Different triggers don't interact.
        effects.greyscale.after = 5
        effects.blur.trigger = .wrong
        effects.blur.after = 2
        XCTAssertFalse(effects.needsBlurAfterGreyscale)
        XCTAssertEqual(effects.validated().blur.after, 2)

        // Out-of-range values normalize.
        var broken = EffectsSettings(
            greyscale: GreyscaleSettings(enabled: true, after: 1),
            blur: BlurSettings(enabled: true, after: 99),
            focus: FocusSettings(enabled: true, span: 33),
            zoom: ZoomSettings(enabled: true, span: 0, scale: 9)
        )
        broken = broken.validated()
        XCTAssertEqual(broken.greyscale.after, 2)
        XCTAssertEqual(broken.blur.after, 10)
        XCTAssertEqual(broken.focus.span, 50)
        XCTAssertEqual(broken.zoom.span, 50)
        XCTAssertEqual(broken.zoom.scale, 4)
    }

    func testEffectChipLabels() {
        let greyscale = YourEffect(kind: .greyscale, trigger: .right, streak: 3)
        XCTAssertEqual(greyscale.label, "Greyscale · 3 right in a row")
        XCTAssertEqual(greyscale.symbol, "circle.lefthalf.filled")
        let blur = YourEffect(kind: .blur, strength: .heavy, trigger: .wrong, streak: 5)
        XCTAssertEqual(blur.label, "Blur · 5 wrong in a row")
        XCTAssertEqual(blur.blurFraction, 0.07)
        XCTAssertEqual(RoundEffect(kind: .focus, spanMs: 1000).label, "Focus · guess early for a bonus")
        XCTAssertEqual(RoundEffect(kind: .zoom, spanMs: 1000, scale: 3).label, "Zoom-out · guess early for a bonus")
        XCTAssertEqual(RoundEffect(kind: .zoom, spanMs: 1000).symbol, "plus.magnifyingglass")
    }

    func testResultBreakdownLines() {
        var row = ResultRow(
            playerID: "p1", targetID: "p2", correct: true, points: 1520, accuracy: 500, speed: 400,
            streakBonus: 100, streak: 3, elapsedMs: 1000, total: 2000
        )
        row.bonus = 120
        row.doubleDown = .won
        row.shielded = true
        row.earnedFiftyFifty = true
        XCTAssertEqual(ResultBreakdown.lines(for: row).map(\.text), [
            "Sharp eyes +120", "Double Down ×2", "Shield saved your streak", "+1 50/50",
        ])
        row.doubleDown = .lost
        XCTAssertEqual(ResultBreakdown.lines(for: row).map(\.text), [
            "Sharp eyes +120", "Double Down −300", "Shield saved your streak", "+1 50/50",
        ])
        row.doubleDown = .refunded
        XCTAssertEqual(ResultBreakdown.lines(for: row).first(where: { $0.text.contains("kept") })?.text, "Double Down kept (your photo)")
        XCTAssertEqual(ResultBreakdown.lines(for: ResultRow(
            playerID: "p2", targetID: nil, correct: false, points: 0, accuracy: 0, speed: 0,
            streakBonus: 0, streak: 0, elapsedMs: nil, total: 0
        )), [])
    }

    func testShopAvailabilityOrderAndReasons() throws {
        let shop = ShopView(open: true, bought: false, prices: .defaults)
        let rich = PlayerView(id: "p", nickname: "P", score: 1000, items: PlayerItems())
        XCTAssertEqual(ShopAvailability.evaluate(item: .doubleDown, player: rich, shop: shop), .available)
        XCTAssertEqual(ShopAvailability.evaluate(item: .shield, player: rich, shop: ShopView(open: true, bought: true, prices: .defaults)), .bought)
        XCTAssertEqual(ShopAvailability.evaluate(item: .shield, player: rich, shop: shop).reason, nil)

        var holding = rich
        holding.items = PlayerItems(doubleDown: 1, shield: 1, fiftyFifty: 2)
        XCTAssertEqual(ShopAvailability.evaluate(item: .doubleDown, player: holding, shop: shop), .alreadyHeld)
        XCTAssertEqual(ShopAvailability.evaluate(item: .shield, player: holding, shop: shop), .alreadyHeld)
        XCTAssertEqual(ShopAvailability.evaluate(item: .fiftyFifty, player: holding, shop: shop), .alreadyHeld)
        XCTAssertEqual(ShopAvailability.alreadyHeld.reason, "You have one")

        var poor = rich
        poor.score = 199
        XCTAssertEqual(ShopAvailability.evaluate(item: .doubleDown, player: poor, shop: shop), .notEnoughPoints)
        XCTAssertEqual(ShopAvailability.evaluate(item: .shield, player: poor, shop: shop), .notEnoughPoints)
        poor.score = 400
        XCTAssertEqual(ShopAvailability.evaluate(item: .fiftyFifty, player: poor, shop: shop), .available)
        XCTAssertEqual(ShopAvailability.bought.reason, "Bought ✓")
        XCTAssertEqual(ShopAvailability.onePerBreak.reason, "One per break")
        XCTAssertEqual(ShopAvailability.notEnoughPoints.reason, "Not enough points")

        // After a purchase, the bought card says so and the others say why not.
        let afterBuy = ShopView(open: true, bought: true, prices: .defaults)
        XCTAssertEqual(ShopAvailability.evaluate(item: .shield, player: rich, shop: afterBuy, lastBought: .shield), .bought)
        XCTAssertEqual(ShopAvailability.evaluate(item: .doubleDown, player: rich, shop: afterBuy, lastBought: .shield), .onePerBreak)
        XCTAssertEqual(ShopAvailability.evaluate(item: .fiftyFifty, player: rich, shop: afterBuy), .bought)
        // The host's pause closes the shop.
        XCTAssertEqual(ShopAvailability.evaluate(item: .shield, player: rich, shop: shop, paused: true), .paused)
        XCTAssertEqual(ShopAvailability.paused.reason, "Paused")
    }

    func testSettingsChipsFollowTheContractOrder() {
        var settings = RoomSettings()
        XCTAssertTrue(SettingsChip.chips(for: settings).isEmpty)

        settings.evenSplit = true
        settings.effects = EffectsSettings(
            greyscale: GreyscaleSettings(enabled: true, trigger: .wrong, after: 4),
            blur: BlurSettings(enabled: true, trigger: .right, after: 5, strength: .heavy),
            focus: FocusSettings(enabled: true),
            zoom: ZoomSettings(enabled: true)
        )
        settings.powerups = PowerupSettings(
            fiftyFifty: FiftyFiftySettings(enabled: true),
            shop: ShopSettings(enabled: true)
        )
        let chips = SettingsChip.chips(for: settings)
        XCTAssertEqual(chips.map(\.label), [
            "Even Split", "Greyscale 4↓", "Blur 5↑", "Focus", "Zoom-out", "50/50", "Shop",
        ])
        XCTAssertEqual(chips.map(\.symbol), [
            "equal.circle.fill", "circle.lefthalf.filled", "drop.fill", "scope",
            "plus.magnifyingglass", "scissors", "cart.fill",
        ])
    }

    func testShopBreakLastsAtLeastTwelveSeconds() {
        var settings = RoomSettings(breakSeconds: 7)
        XCTAssertEqual(settings.effectiveBreakSeconds, 7)
        settings.powerups.shop.enabled = true
        XCTAssertEqual(settings.effectiveBreakSeconds, 12)
        settings.breakSeconds = 20
        XCTAssertEqual(settings.effectiveBreakSeconds, 20)
    }

    func testFinalResultsUseThePlainBreakNotTheShopMinimum() throws {
        var view = try XCTUnwrap(decode(Self.arcadeJSON).state)
        view.phase = .results
        view.settings.breakSeconds = 7
        view.round = RoundView(index: 3, total: 10)
        view.lastResult = RoundResult(index: 3, ownerID: "u_2", kind: .photo, rows: [])
        XCTAssertFalse(view.isFinalResult)
        XCTAssertEqual(view.resultsBreakSeconds, 12)  // a shop break

        view.lastResult?.index = 10
        XCTAssertTrue(view.isFinalResult)
        XCTAssertEqual(view.resultsBreakSeconds, 7)   // the final results get plain breakSeconds
        XCTAssertEqual(view.settings.effectiveBreakSeconds, 12)
    }

    func testFiftyFiftyNeedsAtLeastTwoCuttableWrongChoices() {
        // w = players − (owner if the viewer owns it, else owner + viewer).
        XCTAssertEqual(FiftyFiftyRules.wrongChoices(players: 2, isOwner: false), 0)
        XCTAssertEqual(FiftyFiftyRules.wrongChoices(players: 2, isOwner: true), 1)
        XCTAssertEqual(FiftyFiftyRules.wrongChoices(players: 3, isOwner: false), 1)
        XCTAssertEqual(FiftyFiftyRules.wrongChoices(players: 3, isOwner: true), 2)
        XCTAssertEqual(FiftyFiftyRules.wrongChoices(players: 4, isOwner: false), 2)
        XCTAssertFalse(FiftyFiftyRules.canCut(players: 2, isOwner: false))
        XCTAssertFalse(FiftyFiftyRules.canCut(players: 2, isOwner: true))
        XCTAssertFalse(FiftyFiftyRules.canCut(players: 3, isOwner: false))
        XCTAssertTrue(FiftyFiftyRules.canCut(players: 3, isOwner: true))
        XCTAssertTrue(FiftyFiftyRules.canCut(players: 4, isOwner: false))
    }
}

// MARK: - Effect maths

final class EffectMathTests: XCTestCase {
    func testElapsedFreezesAtThePausedRemainingTime() {
        XCTAssertEqual(EffectMath.elapsedMs(totalMs: 20_000, remainingMs: 13_000), 7000)
        XCTAssertEqual(EffectMath.elapsedMs(totalMs: 20_000, remainingMs: 25_000), 0)
        XCTAssertEqual(EffectMath.elapsedMs(totalMs: 20_000, remainingMs: -1), 20_000)
        XCTAssertEqual(EffectMath.elapsedMs(totalMs: 20_000, remainingMs: 13_000), 7000)
        XCTAssertEqual(EffectMath.elapsedMs(totalMs: 0, remainingMs: 0), 0)
    }

    func testProgressAndEaseOut() {
        XCTAssertEqual(EffectMath.progress(elapsedMs: 5000, spanMs: 10_000), 0.5)
        XCTAssertEqual(EffectMath.progress(elapsedMs: 20_000, spanMs: 10_000), 1)
        XCTAssertEqual(EffectMath.progress(elapsedMs: 5000, spanMs: 0), 1)
        XCTAssertEqual(EffectMath.easeOut(0), 0)
        XCTAssertEqual(EffectMath.easeOut(1), 1)
        XCTAssertEqual(EffectMath.easeOut(0.5), 0.875, accuracy: 0.0001)
    }

    func testFocusBlurAndZoomReachTheirEndState() {
        XCTAssertEqual(EffectMath.focusRadius(shorterSide: 100, progress: 0), 8, accuracy: 0.001)
        XCTAssertEqual(EffectMath.focusRadius(shorterSide: 100, progress: 1), 0, accuracy: 0.001)
        XCTAssertEqual(EffectMath.focusRadius(shorterSide: 100, progress: 0.5), 1, accuracy: 0.001)
        XCTAssertEqual(EffectMath.zoomScale(target: 4, progress: 0), 4, accuracy: 0.001)
        XCTAssertEqual(EffectMath.zoomScale(target: 4, progress: 1), 1, accuracy: 0.001)
        XCTAssertEqual(EffectMath.zoomScale(target: 4, progress: 0.5), 1.375, accuracy: 0.001)
        XCTAssertEqual(EffectMath.scale(nil, progress: 0), 1)
        XCTAssertEqual(EffectMath.scale(RoundEffect(kind: .focus, spanMs: 1000), progress: 0), 1)
    }

    func testStreakBlurStacksWithFocus() {
        let blur = YourEffect(kind: .blur, strength: .heavy, trigger: .wrong, streak: 5)
        // Heavy streak (7 %) plus focus at its start (8 %).
        XCTAssertEqual(EffectMath.blurRadius(shorterSide: 100, streak: blur, round: RoundEffect(kind: .focus, spanMs: 1000), progress: 0), 15, accuracy: 0.001)
        // At the end of focus only the streak effect's blur remains.
        XCTAssertEqual(EffectMath.blurRadius(shorterSide: 100, streak: blur, round: RoundEffect(kind: .focus, spanMs: 1000), progress: 1), 7, accuracy: 0.001)
        // Zoom doesn't blur.
        XCTAssertEqual(EffectMath.blurRadius(shorterSide: 100, streak: nil, round: RoundEffect(kind: .zoom, spanMs: 1000), progress: 0), 0, accuracy: 0.001)
        let greyscale = YourEffect(kind: .greyscale, trigger: .right, streak: 3)
        XCTAssertEqual(EffectMath.blurRadius(shorterSide: 100, streak: greyscale, round: nil, progress: 0), 0, accuracy: 0.001)
    }
}

// MARK: - Bunches sized by the room

final class BunchRequirementTests: XCTestCase {
    private func library(_ id: String, _ kind: MediaKind) -> DeckItem {
        DeckItem(id: id, kind: kind, assetID: id, photoData: nil, videoFile: nil, duration: kind == .video ? 6 : nil, origin: .library(id))
    }

    private func photos(_ count: Int, prefix: String = "p") -> [DeckItem] {
        (0..<count).map { library("\(prefix)\($0)", .photo) }
    }

    private func videos(_ count: Int, prefix: String = "v") -> [DeckItem] {
        (0..<count).map { library("\(prefix)\($0)", .video) }
    }

    func testRequirementPerMode() {
        let evenSplit = BunchRequirement(photos: 3, videos: 1)
        XCTAssertEqual(evenSplit.size(.photo), 3)
        XCTAssertEqual(evenSplit.size(.video), 1)
        XCTAssertEqual(evenSplit.required(.photos), DeckCount(photos: 3, videos: 0))
        XCTAssertEqual(evenSplit.required(.videos), DeckCount(photos: 0, videos: 1))
        XCTAssertEqual(evenSplit.required(.both), DeckCount(photos: 3, videos: 1))
        XCTAssertTrue(evenSplit.fits(DeckCount(photos: 3, videos: 1), mode: .both))
        XCTAssertFalse(evenSplit.fits(DeckCount(photos: 3, videos: 0), mode: .both))
        XCTAssertTrue(evenSplit.fits(DeckCount(photos: 9, videos: 9), mode: .both))
        XCTAssertTrue(evenSplit.fits(DeckCount(photos: 0, videos: 1), mode: .videos))
        // The Milestone 3 defaults still decode the same way.
        XCTAssertEqual(BunchRequirement.defaults.required(.both), DeckCount(photos: 12, videos: 6))
    }

    func testShrinkingDropsTilesFromTheEnd() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(12), source: .library)
        deck.deal(.video, items: videos(6), source: .library)
        XCTAssertTrue(deck.setRequirement(BunchRequirement(photos: 3, videos: 1)))
        XCTAssertEqual(deck.photos.items.map(\.id), ["p0", "p1", "p2"])
        XCTAssertEqual(deck.videos.items.map(\.id), ["v0"])
        XCTAssertEqual(deck.counts(.both), DeckCount(photos: 3, videos: 1))
        XCTAssertTrue(deck.fits(.both))
        // Applying the same requirement is not a change and touches nothing.
        XCTAssertFalse(deck.setRequirement(BunchRequirement(photos: 3, videos: 1)))
        XCTAssertEqual(deck.photos.items.count, 3)
    }

    func testGrowingFillsFromTheTopUp() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(4), source: .library)
        XCTAssertEqual(deck.counts(.photos), DeckCount(photos: 4, videos: 0))
        XCTAssertFalse(deck.fits(.photos))
        XCTAssertEqual(deck.shortfall(.photo), 4)
        deck.setRequirement(BunchRequirement(photos: 6, videos: 0))
        // Growing never happens inside setRequirement; DeckStore draws the tiles.
        XCTAssertEqual(deck.photos.items.count, 4)
        deck.topUp(.photo, items: photos(3, prefix: "n"))
        XCTAssertEqual(deck.photos.items.map(\.id), ["p0", "p1", "p2", "p3", "n0", "n1"])
        XCTAssertNil(deck.shortfall(.photo))
        XCTAssertTrue(deck.fits(.photos))
        // Counts are capped at the required size, never above it.
        deck.topUp(.photo, items: photos(2, prefix: "x"))
        XCTAssertEqual(deck.photos.items.count, 6)
        XCTAssertEqual(deck.counts(.photos), DeckCount(photos: 6, videos: 0))
    }

    func testEvenSplitSizesAreNotMilestone3() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        // 10 rounds over 4 players: share 3 → both {3 photos, 1 video}.
        deck.setRequirement(BunchRequirement(photos: 3, videos: 1))
        deck.deal(.photo, items: photos(12), source: .library)
        deck.deal(.video, items: videos(6), source: .library)
        XCTAssertEqual(deck.photos.items.count, 3)
        XCTAssertEqual(deck.videos.items.count, 1)
        XCTAssertEqual(deck.counts(.both), DeckCount(photos: 3, videos: 1))
        // The Milestone 3 sizes are still available for old servers/fixtures.
        XCTAssertEqual(DeckState.photoSize, 12)
        XCTAssertEqual(DeckState.videoSize, 6)
    }

    func testPoolCapGrowsWithTheRequirement() {
        var deck = DeckState()
        deck.setRequirement(BunchRequirement(photos: 70, videos: 0))
        let added = deck.addToPool((0..<80).map { DeckItem(id: "k\($0)", kind: .photo, assetID: nil, photoData: Data([1]), videoFile: nil, duration: nil, origin: .picked) })
        XCTAssertEqual(added, 70)
        XCTAssertEqual(deck.poolCount(.photo), 70)
    }

    @MainActor func testAZeroSizedBunchHidesItsStep() {
        let store = RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: MemoryVault())
        let settings = RoomSettings(mediaMode: .both)
        store.deck.configure(settings, bunch: BunchRequirement(photos: 3, videos: 0))
        XCTAssertEqual(store.deck.kinds, [.photo])
        store.deck.configure(settings, bunch: BunchRequirement(photos: 3, videos: 1))
        XCTAssertEqual(store.deck.kinds, [.photo, .video])
        XCTAssertEqual(store.deck.requiredSize(.video), 1)
    }

    @MainActor func testRoomStoreTrimsAndTopsUpWhenTheBunchRequirementChanges() async throws {
        let store = RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: MemoryVault())
        var view = try XCTUnwrap(try JSONDecoder().decode(ServerMessage.self, from: Data(RoomStateTests.revealJSON.utf8)).state)
        view.bunch = BunchRequirement(photos: 3, videos: 0)
        store.deck.debugFill(photos: storePhotoItems(12), videos: [])
        store.apply(view)
        XCTAssertEqual(store.deck.requiredSize(.photo), 3)
        XCTAssertEqual(store.deck.bunch(.photo).items.count, 3)

        // Growing tops the bunch up from the pool without user action.
        view.bunch = BunchRequirement(photos: 5, videos: 0)
        store.apply(view)
        for _ in 0..<40 where store.deck.bunch(.photo).items.count < 5 {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(store.deck.bunch(.photo).items.count, 5)
    }

    private func storePhotoItems(_ count: Int) -> [DeckItem] {
        (0..<count).map {
            DeckItem(
                id: "fixture-\($0)",
                kind: .photo,
                assetID: nil,
                photoData: Data([0xFF, 0xD8, 0xFF, 0xD9]),
                videoFile: nil,
                duration: nil,
                origin: .picked
            )
        }
    }

    @MainActor func testFiftyFiftyAvailabilityFollowsTheRevealRules() throws {
        let store = RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: MemoryVault())
        var view = try XCTUnwrap(try JSONDecoder().decode(ServerMessage.self, from: Data(ArcadeDecodingTests.arcadeJSON.utf8)).state)
        // The fixture viewer holds two charges but has already used one this
        // round (eliminated is non-empty), so it is not available.
        store.apply(view)
        XCTAssertFalse(store.canUseFiftyFifty)
        view.round?.eliminated = []
        view.round?.yourGuess = nil
        store.apply(view)
        // Two players leave nobody to cut once the owner and viewer are out.
        XCTAssertFalse(store.canUseFiftyFifty)

        view.players.append(PlayerView(id: "p3", nickname: "Uma", score: 100))
        view.players.append(PlayerView(id: "p4", nickname: "Theo", score: 50))
        store.apply(view)
        XCTAssertTrue(store.canUseFiftyFifty)

        view.paused = true
        store.apply(view)
        XCTAssertFalse(store.canUseFiftyFifty)
        view.paused = false
        view.round?.yourGuess = "u_2"
        store.apply(view)
        XCTAssertFalse(store.canUseFiftyFifty)
        view.round?.yourGuess = nil
        view.players[0].items.fiftyFifty = 0
        store.apply(view)
        XCTAssertFalse(store.canUseFiftyFifty)
    }
}
