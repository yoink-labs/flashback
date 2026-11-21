import CoreGraphics
import SwiftUI
import UIKit
import XCTest
@testable import Flashback

/// Milestone 5 (docs/MILESTONE5.md): the clock-offset estimator, the guess
/// clock, the clearing streak blur, the area-based photo size, tolerant
/// countdown decoding, and the local-reveal decision.

// MARK: - Clock sync (§2)

final class ClockOffsetEstimatorTests: XCTestCase {
    func testOffsetUsesTheFastestRoundTrip() {
        var clock = ClockOffsetEstimator()
        XCTAssertNil(clock.offset, "no pong yet: fall back to the state's clock")
        // rtt 300, offset = 50000 + 150 − 1300
        clock.record(sentAt: 1000, receivedAt: 1300, serverNow: 50_000)
        // rtt 200, offset = 51000 + 100 − 2200
        clock.record(sentAt: 2000, receivedAt: 2200, serverNow: 51_000)
        // rtt 400, offset = 52000 + 200 − 3400
        clock.record(sentAt: 3000, receivedAt: 3400, serverNow: 52_000)
        XCTAssertEqual(clock.offset, 48_900)
        XCTAssertTrue(clock.hasSample)
    }

    func testKeepsOnlyTheLastEightSamples() {
        var clock = ClockOffsetEstimator()
        for i in 0..<12 {
            let sent = Double(i) * 1000
            clock.record(sentAt: sent, receivedAt: sent + Double(1000 - i * 10), serverNow: 1_000_000)
        }
        XCTAssertEqual(clock.samples.count, 8)
        // The newest sample (i = 11, rtt 890) is the fastest of the kept ones.
        XCTAssertEqual(clock.offset, 1_000_000 + 445 - 11_890)
        XCTAssertEqual(clock.samples.last?.rtt, 890)
    }

    func testNonFiniteAndBackwardsSamplesAreSafe() {
        var clock = ClockOffsetEstimator()
        XCTAssertNil(clock.record(sentAt: .nan, receivedAt: 1, serverNow: 1))
        XCTAssertNil(clock.record(sentAt: 1, receivedAt: 2, serverNow: .infinity))
        XCTAssertEqual(clock.samples.count, 0)
        // A clock hiccup can't give a negative rtt.
        clock.record(sentAt: 500, receivedAt: 400, serverNow: 10_000)
        XCTAssertEqual(clock.samples.first?.rtt, 0)
        XCTAssertEqual(clock.offset, 10_000 - 400)
    }

    func testMonotonicClockAnchorsToWallTimeOnce() {
        var ticks = 100.0
        let clock = MonotonicClock(now: 1_700_000_000_000, uptime: { ticks })
        ticks += 2.5
        XCTAssertEqual(clock.nowMs(), 1_700_000_002_500, accuracy: 0.001)
        // Wall time may jump; the monotonic source keeps advancing smoothly.
        ticks += 0.5
        XCTAssertEqual(clock.nowMs(), 1_700_000_003_000, accuracy: 0.001)
    }
}

// MARK: - Guess timing (§4)

final class GuessTimingTests: XCTestCase {
    func testElapsedCountsFromTheReveal() {
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: 13_000, revealAt: 10_000, firstShownAt: nil), 3000)
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: 13_000, revealAt: 10_000, firstShownAt: 10_200), 2800)
    }

    func testLateMediaMovesTheBaseForward() {
        // The reveal began at 10 000 but this device first showed the media at
        // 11 500, so a tap at 13 000 is 1 500 ms, not 3 000.
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: 13_000, revealAt: 10_000, firstShownAt: 11_500), 1500)
        // max(revealAt, firstShown): the reveal time wins when media was ready.
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: 13_000, revealAt: 12_000, firstShownAt: 11_500), 1000)
    }

    func testTapBeforeTheBaseIsZero() {
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: 9_000, revealAt: 10_000, firstShownAt: nil), 0)
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: 9_000, revealAt: nil, firstShownAt: 10_000), 0)
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: 9_000, revealAt: nil, firstShownAt: nil), 0)
        XCTAssertEqual(GuessTiming.elapsedMs(tapAt: .nan, revealAt: 1, firstShownAt: nil), 0)
    }
}

// MARK: - Clearing streak blur (§5)

final class BlurFadeTests: XCTestCase {
    func testStreakBlurClearsAtThreeQuartersOfTheTimer() {
        // Heavy = 7 % of the shorter side, linear to 0 at 75 % of 20 s.
        func radius(_ elapsed: Double, side: CGFloat = 100) -> CGFloat {
            EffectMath.streakBlurRadius(shorterSide: side, fraction: BlurStrength.heavy.blurFraction, elapsedMs: elapsed, timerMs: 20_000)
        }
        XCTAssertEqual(radius(0), 7, accuracy: 0.001)
        XCTAssertEqual(radius(7_500), 3.5, accuracy: 0.001)
        XCTAssertEqual(radius(12_000), 1.4, accuracy: 0.001)
        XCTAssertEqual(radius(15_000), 0, accuracy: 0.001)
        XCTAssertEqual(radius(20_000), 0, accuracy: 0.001)
        XCTAssertEqual(EffectMath.blurClearFraction, 0.75)
        // No timer information yet: no blur rather than a divide by zero.
        XCTAssertEqual(EffectMath.streakBlurRadius(shorterSide: 100, fraction: 0.07, elapsedMs: 0, timerMs: 0), 0)
        XCTAssertEqual(EffectMath.streakBlurRadius(shorterSide: 100, fraction: 0.07, elapsedMs: 0, timerMs: .nan), 0)
    }

    func testBlurUsesTheDisplayedMediasShorterSide() {
        // A panorama box is 2789 × 558: 4 % of its shorter side, not the stage's.
        let radius = EffectMath.streakBlurRadius(shorterSide: 558, fraction: BlurStrength.medium.blurFraction, elapsedMs: 0, timerMs: 20_000)
        XCTAssertEqual(radius, 22.32, accuracy: 0.001)
    }

    func testBlurStacksWithTheUnchangedFocus() {
        let streak = YourEffect(kind: .blur, strength: .light, trigger: .wrong, streak: 3)
        let focus = RoundEffect(kind: .focus, spanMs: 10_000)
        // At the start: 2 % streak + 8 % focus.
        XCTAssertEqual(
            EffectMath.blurRadius(shorterSide: 100, streak: streak, round: focus, progress: 0, elapsedMs: 0, timerMs: 20_000),
            10,
            accuracy: 0.001
        )
        // At 75 % of the round: focus is long gone, streak blur is clear too.
        XCTAssertEqual(
            EffectMath.blurRadius(shorterSide: 100, streak: streak, round: focus, progress: 1, elapsedMs: 15_000, timerMs: 20_000),
            0,
            accuracy: 0.001
        )
    }
}

// MARK: - Same framing (§6)

final class MediaFramingTests: XCTestCase {
    func testAspectFromNaturalSize() {
        XCTAssertEqual(MediaFraming.aspect(of: CGSize(width: 2400, height: 600)), 4, accuracy: 0.0001)
        XCTAssertEqual(MediaFraming.aspect(of: CGSize(width: 900, height: 2400)), 0.375, accuracy: 0.0001)
        XCTAssertEqual(MediaFraming.aspect(of: nil), MediaFraming.fallbackAspect)
        XCTAssertEqual(MediaFraming.aspect(of: .zero), MediaFraming.fallbackAspect)
    }

    func testTheBoxFitsWholeAndCentred() {
        let stage = CGSize(width: 400, height: 300)
        XCTAssertEqual(MediaFraming.size(aspect: 4, in: stage), CGSize(width: 400, height: 100))
        XCTAssertEqual(MediaFraming.size(aspect: 0.5, in: stage), CGSize(width: 150, height: 300))
        XCTAssertEqual(MediaFraming.size(aspect: 4.0 / 3.0, in: stage), CGSize(width: 400, height: 300))
        XCTAssertEqual(MediaFraming.size(aspect: 1, in: stage), CGSize(width: 300, height: 300))
        XCTAssertEqual(MediaFraming.size(aspect: 1, in: .zero), .zero)
        XCTAssertEqual(MediaFraming.size(aspect: 0, in: stage), .zero)
    }

    func testExtremeShapesStayWhole() {
        // The panorama keeps its width and sits as a band; the tall photo fits
        // the height. Neither is cropped.
        let panorama = MediaFraming.size(aspect: 4, in: CGSize(width: 393, height: 240))
        XCTAssertEqual(panorama.width, 393, accuracy: 0.001)
        XCTAssertEqual(panorama.height, 98.25, accuracy: 0.001)
        let tall = MediaFraming.size(aspect: 0.375, in: CGSize(width: 393, height: 240))
        XCTAssertEqual(tall.height, 240, accuracy: 0.001)
        XCTAssertEqual(tall.width, 90, accuracy: 0.001)
    }
}

// MARK: - Scheduled reveal (§3)

final class LocalRevealDecisionTests: XCTestCase {
    func testFlipsOnlyWhenEveryConditionHolds() {
        XCTAssertTrue(LocalReveal.shouldReveal(phase: .countdown, paused: false, revealAt: 1000, serverNow: 1000, mediaReady: true))
        XCTAssertTrue(LocalReveal.shouldReveal(phase: .countdown, paused: false, revealAt: 900, serverNow: 1000, mediaReady: true))
        // Media not decodable yet: "show the reveal as soon as it is".
        XCTAssertFalse(LocalReveal.shouldReveal(phase: .countdown, paused: false, revealAt: 900, serverNow: 1000, mediaReady: false))
        // Not fixed yet.
        XCTAssertFalse(LocalReveal.shouldReveal(phase: .countdown, paused: false, revealAt: nil, serverNow: 1000, mediaReady: true))
        // Still counting.
        XCTAssertFalse(LocalReveal.shouldReveal(phase: .countdown, paused: false, revealAt: 1200, serverNow: 1000, mediaReady: true))
        // A pause freezes the countdown; the server moves revealAt on resume.
        XCTAssertFalse(LocalReveal.shouldReveal(phase: .countdown, paused: true, revealAt: 900, serverNow: 1000, mediaReady: true))
        // Only the countdown flips on its own.
        XCTAssertFalse(LocalReveal.shouldReveal(phase: .reveal, paused: false, revealAt: 900, serverNow: 1000, mediaReady: true))
        XCTAssertFalse(LocalReveal.shouldReveal(phase: .results, paused: false, revealAt: 900, serverNow: 1000, mediaReady: true))
        XCTAssertFalse(LocalReveal.shouldReveal(phase: .countdown, paused: false, revealAt: .nan, serverNow: 1000, mediaReady: true))
    }
}

// MARK: - Decoding and messages (§1–§3)

final class FairRevealDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    private func encode(_ message: ClientMessage) throws -> String {
        let data = try JSONEncoder().encode(message)
        let object = try JSONSerialization.jsonObject(with: data)
        let sorted = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
        return try XCTUnwrap(String(data: sorted, encoding: .utf8))
    }

    func testFixedCountdownCarriesTheRevealPlan() throws {
        let json = #"""
        {"type":"state","state":{"code":"ABC234","phase":"countdown","game":3,"hostID":"p1","capacity":12,
        "settings":{"rounds":10,"timerSeconds":20,"mediaMode":"both"},"serverNow":1700000000000,
        "phaseEndsAt":1700000008000,"startBlocker":null,"players":[],
        "you":{"id":"p1"},
        "round":{"index":4,"total":10,"waiting":false,"kind":"video","revealAt":1700000008000,
          "effect":{"kind":"focus","spanMs":10000},
          "yourEffect":{"kind":"blur","strength":"heavy","trigger":"wrong","streak":6}},
        "lastResult":null,"podium":[]}}
        """#
        let view = try XCTUnwrap(decode(json).state)
        XCTAssertEqual(view.phase, .countdown)
        let round = try XCTUnwrap(view.round)
        XCTAssertEqual(round.waiting, false)
        XCTAssertEqual(round.kind, .video)
        XCTAssertEqual(round.revealAt, 1_700_000_008_000)
        XCTAssertEqual(round.effect?.kind, .focus)
        XCTAssertEqual(round.yourEffect?.kind, .blur)
        XCTAssertEqual(round.yourEffect?.strength, .heavy)
        // The reveal state's timer boundary is not sent during countdown.
        XCTAssertNil(round.endsAt)
    }

    func testWaitingCountdownHasNullsAndNoPlan() throws {
        let json = #"""
        {"type":"state","state":{"code":"ABC234","phase":"countdown","game":3,"hostID":"p1","capacity":12,
        "settings":{"rounds":10,"timerSeconds":20,"mediaMode":"photos"},"serverNow":1700000000000,
        "phaseEndsAt":null,"startBlocker":null,"players":[],"you":{"id":"p1"},
        "round":{"index":4,"total":10,"waiting":true,"kind":null,"revealAt":null,"effect":null,"yourEffect":null},
        "lastResult":null,"podium":[]}}
        """#
        let round = try XCTUnwrap(decode(json).state?.round)
        XCTAssertTrue(round.isWaiting)
        XCTAssertNil(round.revealAt)
        XCTAssertNil(round.kind)
        XCTAssertNil(round.effect)
        XCTAssertNil(round.yourEffect)
    }

    func testGarbageInTheNewRoundFieldsDoesNotDropTheRound() throws {
        let json = #"""
        {"type":"state","state":{"code":"ABC234","phase":"countdown","game":3,"hostID":"p1","capacity":12,
        "settings":{"rounds":10,"timerSeconds":20,"mediaMode":"photos"},"serverNow":1700000000000,
        "phaseEndsAt":1700000008000,"startBlocker":null,"players":[],"you":{"id":"p1"},
        "round":{"index":5,"total":10,"kind":"hologram","revealAt":"soon","effect":7,"yourEffect":[]},
        "lastResult":null,"podium":[]}}
        """#
        let round = try XCTUnwrap(decode(json).state?.round)
        XCTAssertEqual(round.index, 5)
        XCTAssertEqual(round.total, 10)
        XCTAssertNil(round.kind)
        XCTAssertNil(round.revealAt)
        XCTAssertNil(round.effect)
        XCTAssertNil(round.yourEffect)
    }

    func testPongCarriesTheIDAndServerClock() throws {
        let message = try decode(#"{"type":"pong","id":7,"serverNow":1795290000000}"#)
        XCTAssertEqual(message.type, "pong")
        XCTAssertEqual(message.id, 7)
        XCTAssertEqual(message.serverNow, 1_795_290_000_000)
        XCTAssertNil(try decode(#"{"type":"pong"}"#).id)
    }

    func testEncodesTheMilestone5ClientMessages() throws {
        XCTAssertEqual(try encode(.hello(ClientMessage.caps)), #"{"caps":["fairReveal"],"type":"hello"}"#)
        XCTAssertEqual(try encode(.mediaReady(round: 4)), #"{"round":4,"type":"mediaReady"}"#)
        XCTAssertEqual(try encode(.ping(id: 7)), #"{"id":7,"type":"ping"}"#)
        XCTAssertEqual(try encode(.ping(id: nil)), #"{"type":"ping"}"#)
        XCTAssertEqual(try encode(.guess("p2", elapsedMs: 2840)), #"{"elapsedMs":2840,"targetID":"p2","type":"guess"}"#)
        XCTAssertTrue(ClientMessage.ping(id: 3).isPing)
        XCTAssertFalse(ClientMessage.guess("p2", elapsedMs: 0).isPing)
    }
}

// MARK: - The store's local reveal

@MainActor final class ScheduledRevealStoreTests: XCTestCase {
    private func makeStore() -> RoomStore {
        RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: MemoryVault())
    }

    private static let photoData: Data = {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 300)).image { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
        }
        return image.jpegData(compressionQuality: 0.7) ?? Data()
    }()

    private func countdown(now: Double, revealAt: Double?, plan: Bool) -> RoomView {
        RoomView(
            code: "ABC234",
            phase: .countdown,
            game: 3,
            hostID: "p1",
            capacity: 12,
            settings: RoomSettings(rounds: 10, timerSeconds: 20, mediaMode: .photos, breakSeconds: 7, swaps: 3),
            serverNow: now,
            phaseEndsAt: revealAt,
            startBlocker: nil,
            players: [
                PlayerView(id: "p1", nickname: "You", isHost: true, ready: true),
                PlayerView(id: "p2", nickname: "Cal", ready: true),
                PlayerView(id: "p3", nickname: "Uma", ready: true),
            ],
            you: YouView(id: "p1"),
            round: RoundView(
                index: 4,
                total: 10,
                waiting: revealAt == nil,
                kind: plan ? .photo : nil,
                revealAt: revealAt,
                yourEffect: plan ? YourEffect(kind: .blur, strength: .medium, trigger: .wrong, streak: 4) : nil,
                effect: plan ? RoundEffect(kind: .zoom, spanMs: 20_000, scale: 3, originX: 0.6, originY: 0.45) : nil
            ),
            lastResult: nil,
            podium: []
        )
    }

    func testFlipsToTheRevealAndHoldsTheFirstPickUntilTheStateArrives() throws {
        let now = Date().timeIntervalSince1970 * 1000
        let room = makeStore()
        let state = countdown(now: now, revealAt: now - 150, plan: true)
        room.debugLoad(state, media: MediaBlob(kind: .photo, bytes: Self.photoData))

        // The server hasn't said "reveal" yet, but the fixed time has passed and
        // the photo decoded, so this device is already showing it.
        XCTAssertEqual(room.localRevealKey, MediaKey(game: 3, round: 4))
        XCTAssertNotNil(room.revealImage)
        XCTAssertTrue(room.readyMedia.contains(MediaKey(game: 3, round: 4)))
        let shown = try XCTUnwrap(room.displayedView)
        XCTAssertEqual(shown.phase, .reveal)
        XCTAssertEqual(shown.round?.revealAt, now - 150)
        XCTAssertEqual(shown.round?.endsAt, now - 150 + 20_000)
        XCTAssertEqual(shown.round?.yourEffect?.kind, .blur)
        XCTAssertEqual(shown.round?.effect?.kind, .zoom)
        XCTAssertTrue(shown.canGuess)

        room.guess("p2")
        let held = try XCTUnwrap(room.heldGuess)
        XCTAssertEqual(held.targetID, "p2")
        XCTAssertGreaterThanOrEqual(held.elapsedMs, 0)
        XCTAssertLessThan(held.elapsedMs, 1000)
        XCTAssertFalse(room.canGuessNow, "one pick, shown selected and held")
        XCTAssertEqual(room.displayedView?.round?.yourGuess, "p2")

        // The reveal state arrives: the held pick is flushed at the tap's time.
        var reveal = state
        reveal.phase = .reveal
        reveal.phaseEndsAt = (state.round?.revealAt ?? 0) + 20_600
        reveal.round = RoundView(
            index: 4, total: 10, kind: .photo,
            revealAt: state.round?.revealAt,
            endsAt: (state.round?.revealAt ?? 0) + 20_000,
            canGuess: true
        )
        room.apply(reveal)
        XCTAssertNil(room.localRevealKey)
        XCTAssertNil(room.heldGuess)
        XCTAssertEqual(room.displayedView?.phase, .reveal)
        XCTAssertNotNil(room.revealImage, "the same decoded media stays on screen")
    }

    func testDoesNotFlipWhileTheRevealTimeIsNotFixed() throws {
        let now = Date().timeIntervalSince1970 * 1000
        let room = makeStore()
        room.debugLoad(countdown(now: now, revealAt: nil, plan: false), media: MediaBlob(kind: .photo, bytes: Self.photoData))
        XCTAssertNil(room.localRevealKey)
        XCTAssertNil(room.displayedView?.round?.revealAt)
        XCTAssertEqual(room.displayedView?.phase, .countdown)
        XCTAssertFalse(room.canGuessNow)
    }

    func testDoesNotFlipWhilePausedEvenPastTheTime() throws {
        let now = Date().timeIntervalSince1970 * 1000
        let room = makeStore()
        var state = countdown(now: now, revealAt: now - 150, plan: true)
        // While paused the server sends no revealAt (§3, lead update).
        state.round?.revealAt = nil
        state.paused = true
        state.pausedRemainingMs = 900
        room.debugLoad(state, media: MediaBlob(kind: .photo, bytes: Self.photoData))
        XCTAssertNil(room.localRevealKey)
        XCTAssertEqual(room.displayedView?.phase, .countdown)
    }

    func testAFixedCountdownWithoutMediaWaitsForTheDecode() throws {
        let now = Date().timeIntervalSince1970 * 1000
        let room = makeStore()
        room.debugLoad(countdown(now: now, revealAt: now - 150, plan: true))
        XCTAssertNil(room.localRevealKey, "no media yet")

        // The photo arrives late: it is decoded, acked and shown at once.
        let frame = MediaFrame.encode(
            header: MediaHeader(type: "media", game: 3, round: 4, kind: .photo, contentType: "image/jpeg"),
            bytes: Self.photoData
        )
        room.handleMedia(frame)
        XCTAssertEqual(room.localRevealKey, MediaKey(game: 3, round: 4))
        XCTAssertNotNil(room.revealImage)
    }
}
