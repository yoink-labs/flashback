import SwiftUI
import XCTest
@testable import Flashback

@MainActor final class RoomStateTests: XCTestCase {
    static let revealJSON = #"""
    {"type":"state","state":{"code":"ABC234","phase":"reveal","game":1,"hostID":"g_1","capacity":12,
    "settings":{"rounds":5,"timerSeconds":20,"mediaMode":"both"},"serverNow":1700000000000,"phaseEndsAt":1700000020000,
    "startBlocker":null,"players":[
      {"id":"g_1","nickname":"Host","signedIn":false,"isHost":true,"ready":true,"connected":true,"score":0,"streak":0,"photos":0,"videos":0},
      {"id":"u_2","nickname":"Cal","signedIn":true,"isHost":false,"ready":true,"connected":true,"score":875,"streak":1,"photos":0,"videos":1}],
    "you":{"id":"g_1","items":[{"id":"i1","kind":"photo","durationMs":null}]},
    "round":{"index":2,"total":5,"kind":"video","mediaPath":"/v1/rooms/ABC234/media/abc","revealAt":1700000000000,"endsAt":1700000020000,
      "canGuess":true,"isYours":false,"yourGuess":null,"guessedCount":0,"guesserCount":1},
    "lastResult":null,"podium":[]}}
    """#

    func testDecodesServerStateWithGuestsAndSignedInPlayers() throws {
        let message = try JSONDecoder().decode(ServerMessage.self, from: Data(Self.revealJSON.utf8))
        let state = try XCTUnwrap(message.state)
        XCTAssertEqual(state.phase, .reveal)
        XCTAssertEqual(state.players.map(\.signedIn), [false, true])
        XCTAssertTrue(state.isHost)
        XCTAssertEqual(state.round?.kind, .video)
        XCTAssertEqual(state.name("u_2"), "Cal")
        XCTAssertEqual(state.name("gone"), "Someone who left")
    }

    func testEncodesClientMessages() throws {
        let encode = { (m: ClientMessage) in String(data: try JSONEncoder().encode(m), encoding: .utf8)! }
        XCTAssertEqual(try encode(.guess("u_2")).sortedJSON, #"{"targetID":"u_2","type":"guess"}"#.sortedJSON)
        XCTAssertEqual(try encode(.settings(mediaMode: .videos)).sortedJSON, #"{"mediaMode":"videos","type":"settings"}"#.sortedJSON)
        XCTAssertEqual(try encode(.ready(true)).sortedJSON, #"{"ready":true,"type":"ready"}"#.sortedJSON)
    }

    func testLayoutsForDuoPoses() {
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 393, height: 852)), .compact)  // folded / iPhone portrait
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 852, height: 393)), .wide)     // iPhone landscape
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 1100, height: 760)), .wide)    // open wide
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 760, height: 1100)), .tall)    // open tall
        XCTAssertEqual(RoomLayout.forSize(CGSize(width: 600, height: 600)), .tall)     // mid-fold
        XCTAssertEqual(RoomLayout.compact.guessColumns, 2)
        XCTAssertEqual(RoomLayout.wide.guessColumns, 3)
    }

    /// Folding or unfolding re-lays out the room but must not touch game state or playback.
    func testFoldingKeepsLobbyGuessAndPlaybackState() throws {
        let store = RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: MemoryVault())
        store.handle(try JSONDecoder().decode(ServerMessage.self, from: Data(Self.revealJSON.utf8)))
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
        }
    }

    func testRoundEndClearsRevealMediaAndSessionRefreshIsStored() throws {
        let vault = MemoryVault()
        let store = RoomStore(api: APIClient(base: URL(string: "http://127.0.0.1:9")!), vault: vault)
        store.enter(RoomSession(code: "ABC234", playerID: "g_1", nickname: "Host", token: "a.b.c", expiresAt: 4_000_000_000, joinURL: ""))
        store.handle(try JSONDecoder().decode(ServerMessage.self, from: Data(Self.revealJSON.utf8)))
        var results = try XCTUnwrap(store.view)
        results.phase = .results
        results.round = RoundView(index: 2, total: 5)
        store.apply(results)
        XCTAssertNil(store.revealImage)
        XCTAssertNil(store.playback.player)
        store.handle(ServerMessage(type: "session", state: nil, message: nil, reason: nil, token: "new.token.value", expiresAt: 4_100_000_000))
        XCTAssertEqual(vault.load(code: "ABC234")?.token, "new.token.value")
        store.handle(ServerMessage(type: "closed", state: nil, message: nil, reason: "room-closed", token: nil, expiresAt: nil))
        XCTAssertEqual(store.connection, .closed("room-closed"))
        XCTAssertNil(vault.load(code: "ABC234"))
    }
}

private extension String {
    /// Re-serializes JSON with sorted keys for stable comparisons.
    var sortedJSON: String {
        let object = try! JSONSerialization.jsonObject(with: Data(utf8))
        return String(data: try! JSONSerialization.data(withJSONObject: object, options: .sortedKeys), encoding: .utf8)!
    }
}
