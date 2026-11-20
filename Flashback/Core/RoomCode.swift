import Foundation

/// 6-character room codes without look-alikes (no 0/O, 1/I/L). Mirrors worker/src/codes.ts.
enum RoomCode {
    static let alphabet = Set("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
    static let length = 6
    static let webHost = "flashback.yoinklabs.dev"

    /// Uppercases and strips spaces and dashes; returns nil unless the result is a valid code.
    static func normalize(_ input: String) -> String? {
        let code = input.uppercased().filter { $0 != " " && $0 != "-" }
        return code.count == length && code.allSatisfy(alphabet.contains) ? code : nil
    }

    /// For text fields: keeps up to 6 allowed characters as the user types.
    static func sanitize(_ input: String) -> String {
        String(input.uppercased().filter(alphabet.contains).prefix(length))
    }

    static func joinURL(_ code: String) -> URL { URL(string: "https://\(webHost)/join/\(code)")! }

    /// Room code from https://flashback.yoinklabs.dev/join/ABC234, flashback://join/ABC234,
    /// or com.yoinklabs.flashback://join/ABC234.
    static func from(url: URL) -> String? {
        let parts = url.pathComponents.filter { $0 != "/" }
        if url.scheme == "https" || url.scheme == "http" {
            guard parts.count == 2, parts[0] == "join" else { return nil }
            return normalize(parts[1])
        }
        guard url.scheme == "flashback" || url.scheme == "com.yoinklabs.flashback", url.host == "join", let last = parts.last else { return nil }
        return normalize(last)
    }
}

/// Nicknames: 1–24 visible characters after trimming. Uniqueness is checked by the room.
enum Nickname {
    static let maxLength = 24
    static func validate(_ input: String) -> Result<String, NicknameError> {
        let cleaned = input.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
            .filter { !$0.unicodeScalars.allSatisfy { $0.properties.generalCategory == .control || $0.properties.generalCategory == .format } }
        if cleaned.isEmpty { return .failure(.empty) }
        if cleaned.count > maxLength { return .failure(.tooLong) }
        return .success(cleaned)
    }
}

enum NicknameError: LocalizedError, Equatable {
    case empty, tooLong
    var errorDescription: String? {
        switch self {
        case .empty: "Choose a nickname."
        case .tooLong: "Nicknames can be up to \(Nickname.maxLength) characters."
        }
    }
}
