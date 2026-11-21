import Foundation

// Mirrors the Milestone 2 worker view (worker/src/game.ts `Game.view`): exactly
// what one player may see. Nothing here tells a player whose item is showing
// before results — there is no `isYours`, no owner, no media path.

enum Phase: String, Codable { case lobby, countdown, reveal, results, podium, closed }

enum MediaMode: String, Codable, CaseIterable, Identifiable {
    case photos, videos, both

    var id: String { rawValue }
    /// Segmented-control label in the lobby.
    var label: String {
        switch self {
        case .photos: "Photos"
        case .videos: "Videos"
        case .both: "Mix"
        }
    }
    /// Long form for the pre-join room preview.
    var summary: String {
        switch self {
        case .photos: "Photos"
        case .videos: "Videos"
        case .both: "Photos & videos"
        }
    }
}

enum MediaKind: String, Codable {
    case photo, video

    var label: String { self == .photo ? "Photo" : "Video" }
    var symbol: String { self == .photo ? "photo" : "video.fill" }
}

/// How many items a player's deck can contribute in the current media mode.
/// Sent as `{ "type": "deck", "photos": n, "videos": n }`.
struct DeckCount: Codable, Equatable {
    var photos: Int
    var videos: Int

    init(photos: Int = 0, videos: Int = 0) {
        self.photos = photos
        self.videos = videos
    }

    static let zero = DeckCount()

    var total: Int { photos + videos }

    /// Equal bunches (docs/MILESTONE3.md section 7): everyone brings 12 photos
    /// and/or 6 videos.
    static let photoBunch = 12
    static let videoBunch = 6

    /// What a player needs to bring in this mode.
    static func required(_ mode: MediaMode) -> DeckCount {
        switch mode {
        case .photos: DeckCount(photos: photoBunch)
        case .videos: DeckCount(videos: videoBunch)
        case .both: DeckCount(photos: photoBunch, videos: videoBunch)
        }
    }

    /// Whether the bunch is complete for the room's media mode (server `deckFits`).
    func fits(_ mode: MediaMode) -> Bool {
        missing(mode).total == 0
    }

    /// How many more of each kind are needed in this mode.
    func missing(_ mode: MediaMode) -> DeckCount {
        let need = Self.required(mode)
        return DeckCount(photos: max(0, need.photos - photos), videos: max(0, need.videos - videos))
    }

    private enum CodingKeys: String, CodingKey { case photos, videos }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        photos = try c.decodeIfPresent(Int.self, forKey: .photos) ?? 0
        videos = try c.decodeIfPresent(Int.self, forKey: .videos) ?? 0
    }
}

struct RoomSettings: Codable, Equatable {
    var rounds: Int
    var timerSeconds: Int
    var mediaMode: MediaMode
    /// Length of the results screen ("Between rounds"), 3–30 s.
    var breakSeconds: Int
    /// Swaps each player gets per bunch, 0–10.
    var swaps: Int

    init(rounds: Int = 10, timerSeconds: Int = 20, mediaMode: MediaMode = .both, breakSeconds: Int = 7, swaps: Int = 3) {
        self.rounds = rounds
        self.timerSeconds = timerSeconds
        self.mediaMode = mediaMode
        self.breakSeconds = breakSeconds
        self.swaps = swaps
    }

    static let defaults = RoomSettings()

    /// Settings sheet ranges and quick picks (docs/MILESTONE3.md section 2).
    static let roundsRange = 1...30
    static let roundChips = [5, 10, 15, 20]
    static let timerChips = [10, 15, 20, 30, 45, 60]
    static let breakChips = [3, 5, 7, 10, 15]
    static let swapChips = [0, 1, 3, 5]

    /// The lobby settings row: `Mix · 10 rounds · 20s`.
    var summary: String { "\(mediaMode.label) · \(Self.roundsLabel(rounds)) · \(timerSeconds)s" }

    /// "1 round" / "3 rounds".
    static func roundsLabel(_ rounds: Int) -> String { rounds == 1 ? "1 round" : "\(rounds) rounds" }

    private enum CodingKeys: String, CodingKey { case rounds, timerSeconds, mediaMode, breakSeconds, swaps }

    /// Older servers send no `breakSeconds` / `swaps`: those decode as the defaults.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = RoomSettings()
        rounds = try c.decodeIfPresent(Int.self, forKey: .rounds) ?? d.rounds
        timerSeconds = try c.decodeIfPresent(Int.self, forKey: .timerSeconds) ?? d.timerSeconds
        mediaMode = try c.decodeIfPresent(MediaMode.self, forKey: .mediaMode) ?? d.mediaMode
        breakSeconds = try c.decodeIfPresent(Int.self, forKey: .breakSeconds) ?? d.breakSeconds
        swaps = try c.decodeIfPresent(Int.self, forKey: .swaps) ?? d.swaps
    }
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
    var deck: DeckCount

    init(
        id: String,
        nickname: String,
        signedIn: Bool = false,
        isHost: Bool = false,
        ready: Bool = false,
        connected: Bool = true,
        score: Int = 0,
        streak: Int = 0,
        deck: DeckCount = .zero
    ) {
        self.id = id
        self.nickname = nickname
        self.signedIn = signedIn
        self.isHost = isHost
        self.ready = ready
        self.connected = connected
        self.score = score
        self.streak = streak
        self.deck = deck
    }

    private enum CodingKeys: String, CodingKey {
        case id, nickname, signedIn, isHost, ready, connected, score, streak, deck
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        nickname = try c.decode(String.self, forKey: .nickname)
        signedIn = try c.decodeIfPresent(Bool.self, forKey: .signedIn) ?? false
        isHost = try c.decodeIfPresent(Bool.self, forKey: .isHost) ?? false
        ready = try c.decodeIfPresent(Bool.self, forKey: .ready) ?? false
        connected = try c.decodeIfPresent(Bool.self, forKey: .connected) ?? true
        score = try c.decodeIfPresent(Int.self, forKey: .score) ?? 0
        streak = try c.decodeIfPresent(Int.self, forKey: .streak) ?? 0
        deck = try c.decodeIfPresent(DeckCount.self, forKey: .deck) ?? .zero
    }
}

/// `countdown`: `{ index, total, waiting }`.
/// `reveal`: `{ index, total, kind, revealAt, endsAt, canGuess, yourGuess, guessedCount, guesserCount }`.
struct RoundView: Codable, Equatable {
    var index: Int
    var total: Int
    var waiting: Bool?
    var kind: MediaKind?
    var revealAt: Double?
    var endsAt: Double?
    var canGuess: Bool?
    var yourGuess: String?
    var guessedCount: Int?
    var guesserCount: Int?

    init(
        index: Int = 1,
        total: Int = 1,
        waiting: Bool? = nil,
        kind: MediaKind? = nil,
        revealAt: Double? = nil,
        endsAt: Double? = nil,
        canGuess: Bool? = nil,
        yourGuess: String? = nil,
        guessedCount: Int? = nil,
        guesserCount: Int? = nil
    ) {
        self.index = index
        self.total = total
        self.waiting = waiting
        self.kind = kind
        self.revealAt = revealAt
        self.endsAt = endsAt
        self.canGuess = canGuess
        self.yourGuess = yourGuess
        self.guessedCount = guessedCount
        self.guesserCount = guesserCount
    }

    /// True while the server is still waiting for the owner's upload.
    var isWaiting: Bool { waiting == true }
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

/// `you` is just an id in Milestone 2.
struct YouView: Codable, Equatable {
    var id: String
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
    var you: YouView
    var round: RoundView?
    var lastResult: RoundResult?
    var podium: [PodiumEntry]
    /// The host paused the game: timers are frozen and guessing is closed.
    var paused: Bool = false
    /// Time that was left in the phase when it was paused (nil: no deadline).
    var pausedRemainingMs: Double?

    var me: PlayerView? { players.first { $0.id == you.id } }

    /// Milliseconds left until `end`, frozen at `pausedRemainingMs` while paused.
    func remainingMs(until end: Double?, now: Double) -> Double {
        if paused { return max(0, pausedRemainingMs ?? 0) }
        return max(0, (end ?? now) - now)
    }

    /// Countdown, reveal and results: the phases a host can pause.
    var isInRound: Bool { [.countdown, .reveal, .results].contains(phase) }
    /// The host may pause during countdown, reveal, and results.
    var canPause: Bool { isInRound && !paused }
    /// The pause overlay is up (a pause only exists inside a round).
    var showsPause: Bool { isInRound && paused }
    /// The phase has a deadline; while paused, whether it had one when paused.
    /// None in countdown means the upload is still on its way ("Shuffling…").
    var hasDeadline: Bool { paused ? pausedRemainingMs != nil : phaseEndsAt != nil }
    /// Guess buttons are live: the server allows it and the game is not paused.
    var canGuess: Bool { round?.canGuess == true && !paused }
    var isHost: Bool { hostID == you.id }
    /// Results of the last round: the next screen is the podium, not a round.
    var isFinalResult: Bool {
        guard let index = lastResult?.index else { return false }
        return index >= (round?.total ?? settings.rounds)
    }

    func name(_ id: String?) -> String {
        players.first { $0.id == id }?.nickname ?? "Someone who left"
    }

    func player(_ id: String?) -> PlayerView? {
        players.first { $0.id == id }
    }

    /// Join order index, used for the 12-colour player palette.
    func colorIndex(_ id: String?) -> Int {
        players.firstIndex { $0.id == id } ?? 0
    }
}

extension RoomView {
    private enum CodingKeys: String, CodingKey {
        case code, phase, game, hostID, capacity, settings, serverNow, phaseEndsAt, startBlocker
        case players, you, round, lastResult, podium, paused, pausedRemainingMs
    }

    /// `paused` / `pausedRemainingMs` are new in Milestone 3; older servers omit them.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        phase = try c.decode(Phase.self, forKey: .phase)
        game = try c.decodeIfPresent(Int.self, forKey: .game) ?? 0
        hostID = try c.decodeIfPresent(String.self, forKey: .hostID)
        capacity = try c.decodeIfPresent(Int.self, forKey: .capacity) ?? 12
        settings = try c.decodeIfPresent(RoomSettings.self, forKey: .settings) ?? .defaults
        serverNow = try c.decode(Double.self, forKey: .serverNow)
        phaseEndsAt = try c.decodeIfPresent(Double.self, forKey: .phaseEndsAt)
        startBlocker = try c.decodeIfPresent(String.self, forKey: .startBlocker)
        players = try c.decodeIfPresent([PlayerView].self, forKey: .players) ?? []
        you = try c.decode(YouView.self, forKey: .you)
        round = try c.decodeIfPresent(RoundView.self, forKey: .round)
        lastResult = try c.decodeIfPresent(RoundResult.self, forKey: .lastResult)
        podium = try c.decodeIfPresent([PodiumEntry].self, forKey: .podium) ?? []
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        pausedRemainingMs = try c.decodeIfPresent(Double.self, forKey: .pausedRemainingMs)
    }
}

/// One decoded binary WebSocket media frame:
/// `[4-byte big-endian header length][UTF-8 JSON header][media bytes]`.
struct MediaHeader: Codable, Equatable {
    var type: String
    var game: Int
    var round: Int
    var kind: MediaKind
    var contentType: String
}

struct MediaFrame: Equatable {
    /// Matches `URLSessionWebSocketTask.maximumMessageSize`; clips are up to 8 MB.
    static let maxBytes = 16 * 1024 * 1024

    var header: MediaHeader
    var bytes: Data

    static func parse(_ data: Data) -> MediaFrame? {
        guard data.count > 4 else { return nil }
        let start = data.startIndex
        let length =
            (Int(data[start]) << 24) |
            (Int(data[start + 1]) << 16) |
            (Int(data[start + 2]) << 8) |
            Int(data[start + 3])
        guard length > 0, length <= 64 * 1024, length <= data.count - 4 else { return nil }
        let headerStart = start + 4
        let headerEnd = headerStart + length
        guard headerEnd <= data.endIndex else { return nil }
        let headerData = Data(data[headerStart..<headerEnd])
        guard let header = try? JSONDecoder().decode(MediaHeader.self, from: headerData), header.type == "media" else { return nil }
        let body = data[headerEnd..<data.endIndex]
        guard !body.isEmpty, body.count <= maxBytes else { return nil }
        return MediaFrame(header: header, bytes: Data(body))
    }

    /// Encodes a frame; used by tests and kept next to the parser.
    static func encode(header: MediaHeader, bytes: Data) -> Data {
        var data = Data()
        let headerData = (try? JSONEncoder().encode(header)) ?? Data()
        let length = UInt32(headerData.count)
        data.append(UInt8((length >> 24) & 0xFF))
        data.append(UInt8((length >> 16) & 0xFF))
        data.append(UInt8((length >> 8) & 0xFF))
        data.append(UInt8(length & 0xFF))
        data.append(headerData)
        data.append(bytes)
        return data
    }
}

/// Media cache key: one item per (game, round).
struct MediaKey: Hashable {
    var game: Int
    var round: Int
}

struct MediaBlob: Equatable {
    var kind: MediaKind
    var bytes: Data
}

/// Messages the client sends. `auth.<token>` is a WebSocket subprotocol, not a message.
enum ClientMessage: Encodable {
    case ready(Bool)
    case settings(rounds: Int? = nil, timerSeconds: Int? = nil, mediaMode: MediaMode? = nil, breakSeconds: Int? = nil, swaps: Int? = nil)
    case start, advance, end, playAgain, leave, ping, pause, resume
    case guess(String)
    case deck(DeckCount)
    case pass(String)
    case needMedia(Int)

    private enum Key: String, CodingKey {
        case type, ready, rounds, timerSeconds, mediaMode, breakSeconds, swaps, targetID, photos, videos, slot, round
    }

    var isPing: Bool {
        if case .ping = self { return true }
        return false
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case .ready(let ready):
            try c.encode("ready", forKey: .type)
            try c.encode(ready, forKey: .ready)
        case .settings(let rounds, let timer, let mode, let breakSeconds, let swaps):
            try c.encode("settings", forKey: .type)
            try c.encodeIfPresent(rounds, forKey: .rounds)
            try c.encodeIfPresent(timer, forKey: .timerSeconds)
            try c.encodeIfPresent(mode, forKey: .mediaMode)
            try c.encodeIfPresent(breakSeconds, forKey: .breakSeconds)
            try c.encodeIfPresent(swaps, forKey: .swaps)
        case .start: try c.encode("start", forKey: .type)
        case .advance: try c.encode("advance", forKey: .type)
        case .end: try c.encode("end", forKey: .type)
        case .playAgain: try c.encode("playAgain", forKey: .type)
        case .leave: try c.encode("leave", forKey: .type)
        case .ping: try c.encode("ping", forKey: .type)
        case .pause: try c.encode("pause", forKey: .type)
        case .resume: try c.encode("resume", forKey: .type)
        case .guess(let target):
            try c.encode("guess", forKey: .type)
            try c.encode(target, forKey: .targetID)
        case .deck(let count):
            try c.encode("deck", forKey: .type)
            try c.encode(count.photos, forKey: .photos)
            try c.encode(count.videos, forKey: .videos)
        case .pass(let slot):
            try c.encode("pass", forKey: .type)
            try c.encode(slot, forKey: .slot)
        case .needMedia(let round):
            try c.encode("needMedia", forKey: .type)
            try c.encode(round, forKey: .round)
        }
    }
}

/// Messages the server sends as text. Binary media frames are parsed by `MediaFrame`.
struct ServerMessage: Decodable {
    var type: String
    var state: RoomView?
    var message: String?
    var reason: String?
    var token: String?
    var expiresAt: Double?
    var slot: String?
    var game: Int?
    var round: Int?
    var mode: MediaMode?
    /// For `turn`: the kind the owner must upload (Milestone 3; may be missing).
    var kind: MediaKind?
    /// For `error`: which client message failed.
    var request: String? = nil

    init(
        type: String,
        state: RoomView? = nil,
        message: String? = nil,
        reason: String? = nil,
        token: String? = nil,
        expiresAt: Double? = nil,
        slot: String? = nil,
        game: Int? = nil,
        round: Int? = nil,
        mode: MediaMode? = nil,
        kind: MediaKind? = nil
    ) {
        self.type = type
        self.kind = kind
        self.state = state
        self.message = message
        self.reason = reason
        self.token = token
        self.expiresAt = expiresAt
        self.slot = slot
        self.game = game
        self.round = round
        self.mode = mode
    }
}
