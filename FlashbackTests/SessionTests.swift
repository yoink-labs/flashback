import XCTest
@testable import Flashback

final class SessionTests: XCTestCase {
    /// Builds an unsigned token with the given claims. The app only reads claims; the room verifies signatures.
    private func token(code: String = "ABC234", sub: String = "g_1", exp: Double) -> String {
        let b64 = { (s: String) in Data(s.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_") }
        return b64(#"{"alg":"HS256","typ":"JWT"}"#) + "." + b64(#"{"sub":"\#(sub)","aud":"room:\#(code)","exp":\#(Int(exp)),"nick":"Sam","knd":"guest","rid":"x","iss":"flashback"}"#) + ".sig"
    }

    private func session(code: String = "ABC234", exp: Double) -> RoomSession {
        RoomSession(code: code, playerID: "g_1", nickname: "Sam", token: token(code: code, exp: exp), expiresAt: exp, joinURL: "https://flashback.yoinklabs.dev/join/\(code)")
    }

    func testReadsGuestTokenClaims() throws {
        let claims = try XCTUnwrap(RoomSession.claims(of: token(exp: 2_000_000_000)))
        XCTAssertEqual(claims, .init(sub: "g_1", aud: "room:ABC234", exp: 2_000_000_000, nick: "Sam", knd: "guest"))
        XCTAssertNil(RoomSession.claims(of: "nope"))
        XCTAssertNil(RoomSession.claims(of: "a.!!!.c"))
    }

    func testUsableOnlyForItsRoomAndBeforeExpiry() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertTrue(session(exp: 1_000_100).isUsable(now: now))
        XCTAssertFalse(session(exp: 999_999).isUsable(now: now))
        XCTAssertTrue(session(exp: 999_999).isExpired(now: now))
        var other = session(exp: 1_000_100)
        other.code = "XYZ789"
        XCTAssertFalse(other.isUsable(now: now))
        var wrongPlayer = session(exp: 1_000_100)
        wrongPlayer.playerID = "g_2"
        XCTAssertFalse(wrongPlayer.isUsable(now: now))
    }

    func testVaultResumesUsableSessionsAndPrunesDeadOnes() {
        let vault = MemoryVault()
        let now = Date(timeIntervalSince1970: 1_000_000)
        vault.save(session(exp: 1_000_100))
        XCTAssertEqual(vault.resumable(now: now)?.code, "ABC234")
        vault.save(session(code: "XYZ789", exp: 999_000))
        XCTAssertNil(vault.resumable(now: now))
        XCTAssertNil(vault.load(code: "XYZ789"))
        XCTAssertNil(vault.lastCode)
        vault.remove(code: "ABC234")
        XCTAssertNil(vault.load(code: "ABC234"))
    }

    func testRoomCodes() {
        XCTAssertEqual(RoomCode.normalize(" abc-234 "), "ABC234")
        XCTAssertNil(RoomCode.normalize("ABC10O"))
        XCTAssertNil(RoomCode.normalize("ABC23"))
        XCTAssertEqual(RoomCode.sanitize("ab0c1-2349"), "ABC234")
        XCTAssertEqual(RoomCode.from(url: URL(string: "https://flashback.yoinklabs.dev/join/ABC234")!), "ABC234")
        XCTAssertEqual(RoomCode.from(url: URL(string: "flashback://join/abc234")!), "ABC234")
        XCTAssertEqual(RoomCode.from(url: URL(string: "com.yoinklabs.flashback://join/ABC234")!), "ABC234")
        XCTAssertNil(RoomCode.from(url: URL(string: "https://flashback.yoinklabs.dev/room/ABC234")!))
        XCTAssertNil(RoomCode.from(url: URL(string: "com.yoinklabs.flashback://callback")!))
        XCTAssertEqual(RoomCode.joinURL("ABC234").absoluteString, "https://flashback.yoinklabs.dev/join/ABC234")
    }

    func testNicknames() {
        XCTAssertEqual(try Nickname.validate("  Sam   Lee \n").get(), "Sam Lee")
        XCTAssertEqual(Nickname.validate("   "), .failure(.empty))
        XCTAssertEqual(Nickname.validate("\u{200B}"), .failure(.empty))
        XCTAssertEqual(try Nickname.validate(String(repeating: "a", count: 24)).get().count, 24)
        XCTAssertEqual(Nickname.validate(String(repeating: "a", count: 25)), .failure(.tooLong))
        XCTAssertEqual(try Nickname.validate(String(repeating: "👍🏽", count: 24)).get().count, 24)
    }

    func testGuestAndClerkRequestsDifferOnlyByBearer() async throws {
        // A guest create sends no Authorization header; a signed-in create sends the Clerk token.
        let recorder = RequestRecorder()
        let api = APIClient(base: URL(string: "https://example.test")!, urlSession: recorder.session)
        _ = try? await api.createRoom(nickname: "Sam", clerkToken: nil)
        _ = try? await api.joinRoom(code: "ABC234", nickname: "Sam", clerkToken: "clerk.jwt.token")
        XCTAssertEqual(recorder.requests.map(\.url?.path), ["/v1/rooms", "/v1/rooms/ABC234/join"])
        XCTAssertNil(recorder.requests[0].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(recorder.requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer clerk.jwt.token")
        XCTAssertEqual(api.webSocketURL(code: "ABC234").absoluteString, "wss://example.test/v1/rooms/ABC234/ws")
        XCTAssertEqual(APIClient(base: URL(string: "http://127.0.0.1:8787")!).webSocketURL(code: "ABC234").absoluteString, "ws://127.0.0.1:8787/v1/rooms/ABC234/ws")
    }

    func testTurnUploadUsesSlotQueryAndRoomToken() async throws {
        let recorder = RequestRecorder()
        let api = APIClient(base: URL(string: "https://example.test")!, urlSession: recorder.session)
        let session = RoomSession(code: "ABC234", playerID: "g_1", nickname: "Sam", token: "room.token", expiresAt: 4_000_000_000, joinURL: "")
        _ = try? await api.upload(Data([1, 2, 3]), kind: .video, slot: "slot123", session: session)
        let request = try XCTUnwrap(recorder.requests.last)
        XCTAssertEqual(request.url?.path, "/v1/rooms/ABC234/media")
        XCTAssertEqual(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems, [URLQueryItem(name: "slot", value: "slot123")])
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer room.token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "video/mp4")
        XCTAssertEqual(request.httpMethod, "POST")
    }
}

/// Captures requests without touching the network.
final class RequestRecorder: @unchecked Sendable {
    private(set) var requests: [URLRequest] = []
    lazy var session: URLSession = {
        StubProtocol.recorder = self
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }()

    final class StubProtocol: URLProtocol {
        nonisolated(unsafe) static var recorder: RequestRecorder?
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Self.recorder?.requests.append(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"error":"stub"}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }
}
