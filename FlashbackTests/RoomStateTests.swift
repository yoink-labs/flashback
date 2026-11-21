import SwiftUI
import UIKit
import XCTest
@testable import Flashback

@MainActor final class RoomStateTests: XCTestCase {
    /// Milestone 2 view: players carry `deck`, `you` is only an id, and the
    /// round has nothing that tells the owner it is theirs.
    static let revealJSON = #"""
    {"type":"state","state":{"code":"ABC234","phase":"reveal","game":2,"hostID":"g_1","capacity":12,
    "settings":{"rounds":10,"timerSeconds":20,"mediaMode":"both"},"serverNow":1700000000000,"phaseEndsAt":1700000020000,
    "startBlocker":null,"players":[
      {"id":"g_1","nickname":"Host","signedIn":false,"isHost":true,"ready":true,"connected":true,"score":0,"streak":0,"deck":{"photos":12,"videos":3}},
      {"id":"u_2","nickname":"Cal","signedIn":true,"isHost":false,"ready":true,"connected":true,"score":875,"streak":1,"deck":{"photos":0,"videos":1}}],
    "you":{"id":"g_1"},
    "round":{"index":2,"total":10,"kind":"video","revealAt":1700000000000,"endsAt":1700000020000,
      "canGuess":true,"yourGuess":null,"guessedCount":0,"guesserCount":2},
    "lastResult":null,"podium":[]}}
    """#

    static let countdownJSON = #"""
    {"type":"state","state":{"code":"ABC234","phase":"countdown","game":1,"hostID":"g_1","capacity":12,
    "settings":{"rounds":10,"timerSeconds":20,"mediaMode":"photos"},"serverNow":1700000000000,"phaseEndsAt":null,
    "startBlocker":null,"players":[
      {"id":"g_1","nickname":"Host","signedIn":false,"isHost":true,"ready":true,"connected":true,"score":0,"streak":0,"deck":{"photos":12,"videos":0}}],
    "you":{"id":"g_1"},
    "round":{"index":1,"total":10,"waiting":true},
    "lastResult":null,"podium":[]}}
    """#

    private func decode(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    private func makeStore() -> RoomStore {
        RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: MemoryVault())
    }

    func testDecodesMilestone2StateWithDecksAndNoOwnerHint() throws {
        let message = try decode(Self.revealJSON)
        let state = try XCTUnwrap(message.state)
        XCTAssertEqual(state.phase, .reveal)
        XCTAssertEqual(state.players.map(\.deck), [DeckCount(photos: 12, videos: 3), DeckCount(photos: 0, videos: 1)])
        XCTAssertTrue(state.isHost)
        XCTAssertEqual(state.you.id, "g_1")
        XCTAssertEqual(state.round?.kind, .video)
        XCTAssertNil(state.round?.waiting)
        XCTAssertEqual(state.name("u_2"), "Cal")
        XCTAssertEqual(state.name("gone"), "Someone who left")
        XCTAssertEqual(state.colorIndex("u_2"), 1)
        XCTAssertEqual(state.player("u_2")?.score, 875)
    }

    func testCountdownWaitingRound() throws {
        let message = try decode(Self.countdownJSON)
        let state = try XCTUnwrap(message.state)
        XCTAssertEqual(state.phase, .countdown)
        XCTAssertEqual(state.round?.isWaiting, true)
        XCTAssertNil(state.phaseEndsAt)
        XCTAssertEqual(state.settings.mediaMode, .photos)
    }

    func testDecodesRoomInfoWithHostAndSettings() throws {
        let json = #"{"code":"ABC234","phase":"lobby","players":4,"capacity":12,"joinable":true,"host":"Sam","settings":{"rounds":10,"timerSeconds":20,"mediaMode":"both"}}"#
        let info = try JSONDecoder().decode(RoomInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.host, "Sam")
        XCTAssertEqual(info.settings?.rounds, 10)
        XCTAssertEqual(info.modeSummary, "Photos & videos")
        XCTAssertTrue(info.joinable)
    }

    func testEncodesClientMessages() throws {
        let encode = { (m: ClientMessage) in String(data: try JSONEncoder().encode(m), encoding: .utf8)! }
        XCTAssertEqual(try encode(.guess("u_2")).sortedJSON, #"{"targetID":"u_2","type":"guess"}"#.sortedJSON)
        XCTAssertEqual(try encode(.settings(mediaMode: .videos)).sortedJSON, #"{"mediaMode":"videos","type":"settings"}"#.sortedJSON)
        XCTAssertEqual(try encode(.ready(true)).sortedJSON, #"{"ready":true,"type":"ready"}"#.sortedJSON)
        XCTAssertEqual(try encode(.deck(DeckCount(photos: 24, videos: 3))).sortedJSON, #"{"photos":24,"type":"deck","videos":3}"#.sortedJSON)
        XCTAssertEqual(try encode(.pass("abc123")).sortedJSON, #"{"slot":"abc123","type":"pass"}"#.sortedJSON)
        XCTAssertEqual(try encode(.needMedia(4)).sortedJSON, #"{"round":4,"type":"needMedia"}"#.sortedJSON)
        XCTAssertEqual(try encode(.pause).sortedJSON, #"{"type":"pause"}"#.sortedJSON)
        XCTAssertEqual(try encode(.resume).sortedJSON, #"{"type":"resume"}"#.sortedJSON)
        XCTAssertEqual(try encode(.settings(breakSeconds: 10)).sortedJSON, #"{"breakSeconds":10,"type":"settings"}"#.sortedJSON)
        XCTAssertEqual(try encode(.settings(swaps: 0)).sortedJSON, #"{"swaps":0,"type":"settings"}"#.sortedJSON)
        XCTAssertTrue(ClientMessage.ping.isPing)
    }

    func testParsesBinaryMediaFrame() throws {
        let header = MediaHeader(type: "media", game: 2, round: 3, kind: .photo, contentType: "image/jpeg")
        let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00])
        let raw = MediaFrame.encode(header: header, bytes: bytes)
        let frame = try XCTUnwrap(MediaFrame.parse(raw))
        XCTAssertEqual(frame.header, header)
        XCTAssertEqual(frame.bytes, bytes)

        // Hand-built frame: 4-byte big-endian header length + JSON + bytes.
        let json = Data(#"{"type":"media","game":1,"round":2,"kind":"video","contentType":"video/mp4"}"#.utf8)
        var hand = Data()
        let length = UInt32(json.count)
        hand.append(contentsOf: [UInt8((length >> 24) & 0xFF), UInt8((length >> 16) & 0xFF), UInt8((length >> 8) & 0xFF), UInt8(length & 0xFF)])
        hand.append(json)
        hand.append(contentsOf: [1, 2, 3])
        XCTAssertEqual(MediaFrame.parse(hand)?.header.kind, .video)
        XCTAssertEqual(MediaFrame.parse(hand)?.header.round, 2)
        XCTAssertEqual(MediaFrame.parse(hand)?.bytes, Data([1, 2, 3]))

        // Garbage and impossible lengths are ignored, not crashing.
        XCTAssertNil(MediaFrame.parse(Data()))
        XCTAssertNil(MediaFrame.parse(Data([0, 0, 0, 0])))
        XCTAssertNil(MediaFrame.parse(Data("not a frame at all".utf8)))
        // Header claims more bytes than exist.
        XCTAssertNil(MediaFrame.parse(Data([0, 0, 0, 200, 0x7B, 0x7D])))
        // Valid length but not a media header.
        let wrong = Data(#"{"type":"state"}"#.utf8)
        var bad = Data([0, 0, 0, UInt8(wrong.count)])
        bad.append(wrong)
        bad.append(contentsOf: [1])
        XCTAssertNil(MediaFrame.parse(bad))
    }

    func testBinaryFrameShowsPhotoDuringReveal() throws {
        let store = makeStore()
        store.handle(try decode(Self.revealJSON))
        XCTAssertNil(store.revealImage)

        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { ctx in
            UIColor.systemPink.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let jpeg = try XCTUnwrap(image.jpegData(compressionQuality: 0.6))
        let header = MediaHeader(type: "media", game: 2, round: 2, kind: .photo, contentType: "image/jpeg")
        store.handleMedia(MediaFrame.encode(header: header, bytes: jpeg))

        XCTAssertNotNil(store.revealImage)
        XCTAssertFalse(store.revealFailed)
    }

    func testFramesForOtherRoundsAreCachedNotShown() throws {
        let store = makeStore()
        store.handle(try decode(Self.revealJSON))
        let header = MediaHeader(type: "media", game: 2, round: 5, kind: .photo, contentType: "image/jpeg")
        store.handleMedia(MediaFrame.encode(header: header, bytes: Data([0xFF, 0xD8, 0xFF])))
        XCTAssertNil(store.revealImage)
    }

    func testLayoutsForDuoPoses() {
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 393, height: 852)), .compact)  // folded / iPhone portrait
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 852, height: 393)), .wide)     // iPhone landscape
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 1100, height: 760)), .wide)    // open wide
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 760, height: 1100)), .tall)    // open tall
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 600, height: 600)), .tall)     // mid-fold
        XCTAssertEqual(RoomLayout.compact.guessColumns, 4)
        XCTAssertEqual(RoomLayout.wide.guessColumns, 3)
        XCTAssertEqual(RoomLayout.tall.guessColumns, 3)
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 382, height: 678)), .compact)  // Duo outer, minus the vertical bar
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 867, height: 669)), .wide)     // Duo inner, minus the vertical bar
        // Duo outer with the keyboard up reads as wide. Home and Join must pick their
        // layout from the keyboard-free size (KeyboardStableLayout), or focusing a
        // text field on the cover swaps panes and drops the focus.
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 382, height: 380)), .wide)
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 382, height: 678)), .compact)
        XCTAssertEqual(RoomLayout.compact.bunchColumns(.photo), 3)
        XCTAssertEqual(RoomLayout.tall.bunchColumns(.photo), 4)
        XCTAssertEqual(RoomLayout.compact.bunchColumns(.video), 3)
    }

    func testMilestone3SettingsAndPauseDecodeWithDefaults() throws {
        // Old server: no breakSeconds / swaps / paused.
        let state = try XCTUnwrap(decode(Self.revealJSON).state)
        XCTAssertEqual(state.settings.breakSeconds, 7)
        XCTAssertEqual(state.settings.swaps, 3)
        XCTAssertFalse(state.paused)
        XCTAssertNil(state.pausedRemainingMs)
        XCTAssertEqual(state.settings.summary, "Mix · 10 rounds · 20s")
        var single = state.settings
        single.rounds = 1
        XCTAssertEqual(single.summary, "Mix · 1 round · 20s")
        XCTAssertEqual(RoomSettings.roundsLabel(3), "3 rounds")

        let paused = Self.revealJSON
            .replacingOccurrences(of: #""mediaMode":"both"}"#, with: #""mediaMode":"both","breakSeconds":15,"swaps":5}"#)
            .replacingOccurrences(of: #""podium":[]}"#, with: #""podium":[],"paused":true,"pausedRemainingMs":12000}"#)
        let view = try XCTUnwrap(decode(paused).state)
        XCTAssertEqual(view.settings.breakSeconds, 15)
        XCTAssertEqual(view.settings.swaps, 5)
        XCTAssertTrue(view.paused)
        XCTAssertEqual(view.pausedRemainingMs, 12000)
        // Timers freeze at the paused remaining time.
        XCTAssertEqual(view.remainingMs(until: 1, now: 999_999_999), 12000)
        XCTAssertFalse(view.canPause)
        XCTAssertTrue(state.canPause)
        XCTAssertEqual(state.remainingMs(until: 1_700_000_020_000, now: 1_700_000_005_000), 15000)
    }

    func testFinalResultIsTheLastRound() throws {
        var view = try XCTUnwrap(decode(Self.revealJSON).state)
        XCTAssertFalse(view.isFinalResult)  // no result yet
        view.phase = .results
        view.lastResult = RoundResult(index: 2, ownerID: "g_1", kind: .photo, rows: [])
        XCTAssertFalse(view.isFinalResult)  // round 2 of 10
        view.lastResult?.index = 10
        XCTAssertTrue(view.isFinalResult)
        view.round = nil  // falls back to settings.rounds
        view.settings.rounds = 1
        view.lastResult?.index = 1
        XCTAssertTrue(view.isFinalResult)
    }

    func testRoundPhasePredicatesDrivePauseAndGuessing() throws {
        var view = try XCTUnwrap(decode(Self.revealJSON).state)
        XCTAssertTrue(view.isInRound)
        XCTAssertTrue(view.canGuess)
        XCTAssertTrue(view.hasDeadline)
        XCTAssertFalse(view.showsPause)

        view.paused = true
        view.pausedRemainingMs = nil
        XCTAssertTrue(view.showsPause)
        XCTAssertFalse(view.canGuess)
        XCTAssertFalse(view.canPause)
        XCTAssertFalse(view.hasDeadline)  // paused while still waiting for the upload
        view.pausedRemainingMs = 900
        XCTAssertTrue(view.hasDeadline)

        view.phase = .lobby
        XCTAssertFalse(view.isInRound)
        XCTAssertFalse(view.showsPause)  // a stale flag never shows the overlay outside a round

        let countdown = try XCTUnwrap(decode(Self.countdownJSON).state)
        XCTAssertFalse(countdown.hasDeadline)
        XCTAssertFalse(countdown.canGuess)
    }

    func testPauseHoldsTheClipAndResumePlaysOn() throws {
        let store = makeStore()
        store.handle(try decode(Self.revealJSON))
        let clip = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "web-clip", withExtension: "mp4")))
        store.handleMedia(MediaFrame.encode(header: MediaHeader(type: "media", game: 2, round: 2, kind: .video, contentType: "video/mp4"), bytes: clip))
        let player = try XCTUnwrap(store.playback.player)
        XCTAssertNotEqual(player.rate, 0)

        var view = try XCTUnwrap(store.view)
        view.paused = true
        view.pausedRemainingMs = 9000
        store.apply(view)
        XCTAssertEqual(player.rate, 0)
        XCTAssertTrue(store.playback.player === player)  // same clip, same frame

        view.paused = false
        view.pausedRemainingMs = nil
        store.apply(view)
        XCTAssertNotEqual(player.rate, 0)

        view.phase = .results
        view.lastResult = RoundResult(index: 2, ownerID: "g_1", kind: .video, rows: [])
        store.apply(view)
        XCTAssertEqual(player.rate, 0)  // results hold the last frame
        XCTAssertTrue(store.canSave)
    }

    func testToastsWithAnActionStayLonger() {
        XCTAssertEqual(Toast(text: "Saved", symbol: "checkmark").duration, .seconds(2))
        XCTAssertEqual(Toast(text: "Allow", symbol: "x", isError: true, action: .openSettings).duration, .seconds(5))
        XCTAssertEqual(MediaSaver.SaveError.denied.errorDescription, "Allow Flashback to add to Photos in Settings.")
    }

    func testTurnKindDecodes() throws {
        let turn = try decode(#"{"type":"turn","slot":"s1","game":1,"round":2,"mode":"both","kind":"video"}"#)
        XCTAssertEqual(turn.kind, .video)
        let old = try decode(#"{"type":"turn","slot":"s1","game":1,"round":2,"mode":"both"}"#)
        XCTAssertNil(old.kind)
    }

    func testSettingsReachTheDeckAndClampSwaps() throws {
        let store = makeStore()
        store.handle(try decode(Self.revealJSON))
        XCTAssertEqual(store.deck.mode, .both)
        XCTAssertEqual(store.deck.kinds, [.photo, .video])
        XCTAssertEqual(store.deck.state.swapLimit, 3)
        var view = try XCTUnwrap(store.view)
        view.settings.swaps = 1
        view.settings.mediaMode = .videos
        store.apply(view)
        XCTAssertEqual(store.deck.state.swapLimit, 1)
        XCTAssertEqual(store.deck.currentStep, .video)
    }

    /// Folding or unfolding re-lays out the room but must not touch game state,
    /// the deck, the draft, or playback.
    func testFoldingKeepsStateDeckAndPlayback() throws {
        let store = makeStore()
        store.handle(try decode(Self.revealJSON))
        store.playback.muted = false
        store.draftNickname = "Host"
        let clip = FileManager.default.temporaryDirectory.appendingPathComponent("fold-\(UUID().uuidString).mp4")
        try FileManager.default.copyItem(at: XCTUnwrap(Bundle(for: Self.self).url(forResource: "web-clip", withExtension: "mp4")), to: clip)
        store.playback.play(file: clip)
        let player = try XCTUnwrap(store.playback.player)
        let view = store.view

        let host = UIHostingController(rootView: RoomScreen().environmentObject(store))
        for size in [CGSize(width: 393, height: 852), CGSize(width: 1100, height: 760), CGSize(width: 760, height: 1100), CGSize(width: 393, height: 852)] {
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            XCTAssertEqual(store.view, view)
            XCTAssertTrue(store.playback.player === player)
            XCTAssertFalse(store.playback.muted)
            XCTAssertEqual(store.draftNickname, "Host")
            XCTAssertEqual(store.deck.items.count, 0)
        }
    }

    func testResultsKeepsMediaThenNextPhaseClearsIt() throws {
        let vault = MemoryVault()
        let store = RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: vault)
        store.enter(RoomSession(code: "ABC234", playerID: "g_1", nickname: "Host", token: "a.b.c", expiresAt: 4_000_000_000, joinURL: ""))
        store.handle(try decode(Self.revealJSON))

        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let jpeg = try XCTUnwrap(image.jpegData(compressionQuality: 0.6))
        let header = MediaHeader(type: "media", game: 2, round: 2, kind: .photo, contentType: "image/jpeg")
        store.handleMedia(MediaFrame.encode(header: header, bytes: jpeg))
        XCTAssertNotNil(store.revealImage)

        var results = try XCTUnwrap(store.view)
        results.phase = .results
        results.round = RoundView(index: 2, total: 10)
        results.lastResult = RoundResult(index: 2, ownerID: "g_1", kind: .photo, rows: [])
        store.apply(results)
        XCTAssertNotNil(store.revealImage)  // small thumbnail beside "It was Host's!"
        XCTAssertTrue(store.canSave)         // the round's media can still be saved

        results.phase = .podium
        store.apply(results)
        XCTAssertNil(store.revealImage)
        XCTAssertFalse(store.canSave)

        store.handle(ServerMessage(type: "session", token: "new.token.value", expiresAt: 4_100_000_000))
        XCTAssertEqual(vault.load(code: "ABC234")?.token, "new.token.value")
        store.handle(ServerMessage(type: "closed", reason: "room-closed"))
        XCTAssertEqual(store.connection, .closed("room-closed"))
        XCTAssertNil(vault.load(code: "ABC234"))
    }

    func testTurnMessageNeverPublishesTurnUI() throws {
        let store = makeStore()
        // No session and no socket: the turn is a no-op for the UI, which is the
        // point — nothing may hint that it is this player's turn.
        store.handle(ServerMessage(type: "turn", slot: "slot-1", game: 1, round: 1, mode: .both))
        XCTAssertNil(store.error)
        XCTAssertNil(store.revealImage)
        XCTAssertFalse(store.revealFailed)
        XCTAssertEqual(store.connection, .idle)
    }
}

private extension String {
    /// Re-serializes JSON with sorted keys for stable comparisons.
    var sortedJSON: String {
        let object = try! JSONSerialization.jsonObject(with: Data(utf8))
        return String(data: try! JSONSerialization.data(withJSONObject: object, options: .sortedKeys), encoding: .utf8)!
    }
}
