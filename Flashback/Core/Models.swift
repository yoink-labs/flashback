import Foundation

// Mirrors worker/src/game.ts `Game.view`: exactly what one player may see.
enum Phase: String, Codable { case lobby, countdown, reveal, results, podium, closed }
enum MediaMode: String, Codable, CaseIterable, Identifiable {
    case photos, videos, both
    var id: String { rawValue }
    var label: String { switch self { case .photos: "Photos"; case .videos: "Videos"; case .both: "Both" } }
}
enum MediaKind: String, Codable { case photo, video }

struct RoomSettings: Codable, Equatable {
    var rounds: Int
    var timerSeconds: Int
    var mediaMode: MediaMode
}

struct PlayerView: Codable, Equatable, Identifiable {
    var id: String
    var nickname: String
    var signedIn: Bool
    var isHost: Bool
    var ready: Bool
    var connected: Bool
    var score: Int
    var streak: Int
    var photos: Int
    var videos: Int
}

struct RoundView: Codable, Equatable {
    var index: Int
    var total: Int
    var kind: MediaKind?
    var mediaPath: String?
    var revealAt: Double?
    var endsAt: Double?
    var canGuess: Bool?
    var isYours: Bool?
    var yourGuess: String?
    var guessedCount: Int?
    var guesserCount: Int?
}

struct ResultRow: Codable, Equatable, Identifiable {
    var playerID: String
    var targetID: String?
    var correct: Bool
    var points: Int
    var accuracy: Int
    var speed: Int
    var streakBonus: Int
    var streak: Int
    var elapsedMs: Double?
    var total: Int
    var id: String { playerID }
}

struct RoundResult: Codable, Equatable {
    var index: Int
    var ownerID: String
    var kind: MediaKind
    var rows: [ResultRow]
}

struct PodiumEntry: Codable, Equatable, Identifiable {
    var playerID: String
    var rank: Int
    var score: Int
    var bestStreak: Int
    var correctCount: Int
    var id: String { playerID }
}

struct YourItems: Codable, Equatable {
    struct Item: Codable, Equatable, Identifiable { var id: String; var kind: MediaKind; var durationMs: Double? }
    var id: String
    var items: [Item]
}

struct RoomView: Codable, Equatable {
    var code: String
    var phase: Phase
    var game: Int
    var hostID: String?
    var capacity: Int
    var settings: RoomSettings
    var serverNow: Double
    var phaseEndsAt: Double?
    var startBlocker: String?
    var players: [PlayerView]
    var you: YourItems
    var round: RoundView?
    var lastResult: RoundResult?
    var podium: [PodiumEntry]

    var me: PlayerView? { players.first { $0.id == you.id } }
    var isHost: Bool { hostID == you.id }
    func name(_ id: String?) -> String { players.first { $0.id == id }?.nickname ?? "Someone who left" }
}

struct ServerMessage: Decodable {
    var type: String
    var state: RoomView?
    var message: String?
    var reason: String?
    var token: String?
    var expiresAt: Double?
}

enum ClientMessage: Encodable {
    case ready(Bool)
    case settings(rounds: Int? = nil, timerSeconds: Int? = nil, mediaMode: MediaMode? = nil)
    case start, advance, end, playAgain, leave, ping
    case guess(String)
    case removeItem(String)

    private enum Key: String, CodingKey { case type, ready, rounds, timerSeconds, mediaMode, targetID, itemID }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .ready(let ready): try c.encode("ready", forKey: .type); try c.encode(ready, forKey: .ready)
        case .settings(let rounds, let timer, let mode):
            try c.encode("settings", forKey: .type)
            try c.encodeIfPresent(rounds, forKey: .rounds)
            try c.encodeIfPresent(timer, forKey: .timerSeconds)
            try c.encodeIfPresent(mode, forKey: .mediaMode)
        case .start: try c.encode("start", forKey: .type)
        case .advance: try c.encode("advance", forKey: .type)
        case .end: try c.encode("end", forKey: .type)
        case .playAgain: try c.encode("playAgain", forKey: .type)
        case .leave: try c.encode("leave", forKey: .type)
        case .ping: try c.encode("ping", forKey: .type)
        case .guess(let target): try c.encode("guess", forKey: .type); try c.encode(target, forKey: .targetID)
        case .removeItem(let id): try c.encode("removeItem", forKey: .type); try c.encode(id, forKey: .itemID)
        }
    }
}
