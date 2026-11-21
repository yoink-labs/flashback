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
        XCTAssertEqual(RoomLayout.compact.deckColumns, 3)
        XCTAssertEqual(RoomLayout.tall.deckColumns, 5)
        XCTAssertEqual(RoomLayout.wide.deckColumns, 6)
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

        results.phase = .podium
        store.apply(results)
        XCTAssertNil(store.revealImage)

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
