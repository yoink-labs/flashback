import Foundation
import Security

/// A room session from the Worker: a short-lived HS256 token scoped to one room,
/// one player id, and one nickname. Guests and signed-in players both get one.
struct RoomSession: Codable, Equatable {
    var code: String
    var playerID: String
    var nickname: String
    var token: String
    /// Seconds since 1970.
    var expiresAt: Double
    var joinURL: String

    func isExpired(now: Date = .now) -> Bool { Date(timeIntervalSince1970: expiresAt) <= now }

    /// Claims the client can read (not verify) to make sure a stored token belongs here.
    struct Claims: Decodable, Equatable {
        var sub: String
        var aud: String
        var exp: Double
        var nick: String
        var knd: String
    }

    static func claims(of token: String) -> Claims? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var base64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64) else { return nil }
        return try? JSONDecoder().decode(Claims.self, from: data)
    }

    /// True when the token is for this room and player and has not expired.
    func isUsable(now: Date = .now) -> Bool {
        guard let claims = Self.claims(of: token) else { return false }
        return claims.aud == "room:\(code)" && claims.sub == playerID && Date(timeIntervalSince1970: claims.exp) > now
    }
}

/// Where room sessions live between launches. Keychain in the app, memory in tests.
protocol SessionVault: AnyObject {
    func save(_ session: RoomSession)
    func load(code: String) -> RoomSession?
    func remove(code: String)
    var lastCode: String? { get set }
}

extension SessionVault {
    /// The most recent session that is still usable, pruning dead ones.
    func resumable(now: Date = .now) -> RoomSession? {
        guard let code = lastCode else { return nil }
        if let session = load(code: code), session.isUsable(now: now) { return session }
        remove(code: code)
        lastCode = nil
        return nil
    }
}

final class MemoryVault: SessionVault {
    private var store: [String: RoomSession] = [:]
    var lastCode: String?
    func save(_ session: RoomSession) { store[session.code] = session; lastCode = session.code }
    func load(code: String) -> RoomSession? { store[code] }
    func remove(code: String) { store[code] = nil; if lastCode == code { lastCode = nil } }
}

final class KeychainVault: SessionVault {
    private let service = "com.yoinklabs.flashback.room-sessions"
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var lastCode: String? {
        get { defaults.string(forKey: "flashback.lastRoom") }
        set { defaults.set(newValue, forKey: "flashback.lastRoom") }
    }

    private func query(_ code: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: code]
    }

    func save(_ session: RoomSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        SecItemDelete(query(session.code) as CFDictionary)
        var item = query(session.code)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
        lastCode = session.code
    }

    func load(code: String) -> RoomSession? {
        var q = query(code)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(RoomSession.self, from: data)
    }

    func remove(code: String) {
        SecItemDelete(query(code) as CFDictionary)
        if lastCode == code { lastCode = nil }
    }
}
