import Foundation

struct APIError: LocalizedError, Equatable {
    var status: Int
    var message: String
    var errorDescription: String? { message }
}

struct RoomInfo: Codable, Equatable {
    var code: String
    var phase: String
    var players: Int
    var capacity: Int
    var joinable: Bool
}

/// HTTP calls to the Flashback Worker. Guests send no Authorization header when
/// creating or joining; signed-in players send their Clerk session token. After
/// that, every call uses the room session token.
struct APIClient {
    var base: URL
    var urlSession: URLSession = .shared

    static var defaultBase: URL {
        #if DEBUG
        // Local development: -flashbackAPI http://127.0.0.1:8787 (wrangler dev).
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-flashbackAPI"), args.indices.contains(i + 1), let url = URL(string: args[i + 1]) { return url }
        #endif
        return URL(string: "https://\(RoomCode.webHost)")!
    }

    private func send<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil, contentType: String? = nil, bearer: String? = nil) async throws -> T {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = body
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let data: Data, response: URLResponse
        do { (data, response) = try await urlSession.data(for: request) }
        catch { throw APIError(status: 0, message: "Couldn't reach Flashback. Check your connection.") }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Something went wrong. Try again."
            throw APIError(status: status, message: message)
        }
        if T.self == Data.self { return data as! T }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func createRoom(nickname: String, clerkToken: String?) async throws -> RoomSession {
        try await send("v1/rooms", method: "POST", body: try JSONEncoder().encode(["nickname": nickname]), contentType: "application/json", bearer: clerkToken)
    }

    func joinRoom(code: String, nickname: String, clerkToken: String?) async throws -> RoomSession {
        try await send("v1/rooms/\(code)/join", method: "POST", body: try JSONEncoder().encode(["nickname": nickname]), contentType: "application/json", bearer: clerkToken)
    }

    func roomInfo(code: String) async throws -> RoomInfo { try await send("v1/rooms/\(code)") }

    func upload(_ data: Data, kind: MediaKind, session: RoomSession) async throws {
        struct Created: Decodable {}
        let _: Created = try await send("v1/rooms/\(session.code)/media", method: "POST", body: data, contentType: kind == .photo ? "image/jpeg" : "video/mp4", bearer: session.token)
    }

    func media(path: String, session: RoomSession) async throws -> Data {
        try await send(String(path.drop(while: { $0 == "/" })), bearer: session.token)
    }

    func leave(session: RoomSession) async {
        struct OK: Decodable {}
        let _: OK? = try? await send("v1/rooms/\(session.code)/leave", method: "POST", bearer: session.token)
    }

    func webSocketURL(code: String) -> URL {
        var components = URLComponents(url: base.appending(path: "v1/rooms/\(code)/ws"), resolvingAgainstBaseURL: false)!
        components.scheme = base.scheme == "http" ? "ws" : "wss"
        return components.url!
    }
}
