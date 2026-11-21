import Foundation

struct APIError: LocalizedError, Equatable {
    var status: Int
    var message: String
    var errorDescription: String? { message }
}

/// `GET /v1/rooms/:code` — enough to preview a room before joining.
struct RoomInfo: Codable, Equatable {
    var code: String
    var phase: String
    var players: Int
    var capacity: Int
    var joinable: Bool
    var host: String?
    var settings: RoomSettings?
    /// Milestone 4: the room's bunch sizes. Old servers mean Milestone 3 sizes.
    var bunch: BunchRequirement = .defaults

    var modeSummary: String { settings?.mediaMode.summary ?? "Photos & videos" }
    var rounds: Int { settings?.rounds ?? 10 }

    private enum CodingKeys: String, CodingKey {
        case code, phase, players, capacity, joinable, host, settings, bunch
    }

    init(code: String, phase: String, players: Int, capacity: Int, joinable: Bool, host: String?, settings: RoomSettings?, bunch: BunchRequirement = .defaults) {
        self.code = code
        self.phase = phase
        self.players = players
        self.capacity = capacity
        self.joinable = joinable
        self.host = host
        self.settings = settings
        self.bunch = bunch
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        phase = try c.decodeIfPresent(String.self, forKey: .phase) ?? "lobby"
        players = try c.decodeIfPresent(Int.self, forKey: .players) ?? 0
        capacity = try c.decodeIfPresent(Int.self, forKey: .capacity) ?? 12
        joinable = try c.decodeIfPresent(Bool.self, forKey: .joinable) ?? false
        host = try c.decodeIfPresent(String.self, forKey: .host)
        settings = try? c.decodeIfPresent(RoomSettings.self, forKey: .settings)
        bunch = (try? c.decodeIfPresent(BunchRequirement.self, forKey: .bunch)) ?? .defaults
    }
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

    private func makeRequest(
        _ path: String,
        method: String,
        body: Data?,
        contentType: String?,
        bearer: String?,
        query: [URLQueryItem]
    ) -> URLRequest {
        var components = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        var request = URLRequest(url: components?.url ?? base)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpBody = body
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func perform(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil,
        bearer: String? = nil,
        query: [URLQueryItem] = []
    ) async throws -> Data {
        let request = makeRequest(path, method: method, body: body, contentType: contentType, bearer: bearer, query: query)
        let data: Data, response: URLResponse
        do { (data, response) = try await urlSession.data(for: request) }
        catch { throw APIError(status: 0, message: "Couldn't reach Flashback. Check your connection.") }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? "Something went wrong. Try again."
            throw APIError(status: status, message: message)
        }
        return data
    }

    private func send<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil,
        bearer: String? = nil
    ) async throws -> T {
        let data = try await perform(path, method: method, body: body, contentType: contentType, bearer: bearer)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func createRoom(nickname: String, clerkToken: String?) async throws -> RoomSession {
        try await send("v1/rooms", method: "POST", body: try JSONEncoder().encode(["nickname": nickname]), contentType: "application/json", bearer: clerkToken)
    }

    func joinRoom(code: String, nickname: String, clerkToken: String?) async throws -> RoomSession {
        try await send("v1/rooms/\(code)/join", method: "POST", body: try JSONEncoder().encode(["nickname": nickname]), contentType: "application/json", bearer: clerkToken)
    }

    func roomInfo(code: String) async throws -> RoomInfo {
        try await send("v1/rooms/\(code)")
    }

    /// The owner's turn upload: one item for one slot, as JPEG or MP4 bytes.
    /// The worker answers with an empty or JSON body; neither is decoded.
    func upload(_ data: Data, kind: MediaKind, slot: String, session: RoomSession) async throws {
        _ = try await perform(
            "v1/rooms/\(session.code)/media",
            method: "POST",
            body: data,
            contentType: kind == .photo ? "image/jpeg" : "video/mp4",
            bearer: session.token,
            query: [URLQueryItem(name: "slot", value: slot)]
        )
    }

    func leave(session: RoomSession) async {
        _ = try? await perform("v1/rooms/\(session.code)/leave", method: "POST", bearer: session.token)
    }

    func webSocketURL(code: String) -> URL {
        var components = URLComponents(url: base.appending(path: "v1/rooms/\(code)/ws"), resolvingAgainstBaseURL: false)!
        components.scheme = base.scheme == "http" ? "ws" : "wss"
        return components.url!
    }
}
