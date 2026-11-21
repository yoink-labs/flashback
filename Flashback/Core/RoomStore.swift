import AVFoundation
import Foundation
import SwiftUI
import UIKit

enum Connection: Equatable { case idle, connecting, open, reconnecting, closed(String) }

/// A short confirmation at the top of the room ("Saved", "Code copied").
struct Toast: Equatable, Identifiable {
    /// The one thing a toast can offer to do.
    enum Action: Equatable { case openSettings }

    var id = UUID()
    var text: String
    var symbol: String
    var isError = false
    var action: Action?

    /// Toasts with an action stay long enough to reach it.
    var duration: Duration { action == nil ? .seconds(2) : .seconds(5) }
}

/// All room state for the app: session, server view, connection, reveal media,
/// the player's deck, and prepared uploads. Views are pure functions of this store.
@MainActor final class RoomStore: ObservableObject {
    @Published private(set) var session: RoomSession?
    @Published private(set) var view: RoomView?
    @Published private(set) var connection: Connection = .idle
    @Published var error: String?
    @Published var busy = false
    @Published var revealImage: UIImage?
    @Published var revealFailed = false
    @Published var draftCode = ""
    @Published var draftNickname = ""
    @Published var showJoin = false
    @Published var roomInfo: RoomInfo?
    @Published var previewLoading = false
    @Published var previewError: String?
    @Published private(set) var toast: Toast?
    @Published private(set) var saving = false

    let deck: DeckStore
    let playback = PlaybackController()

    var api: APIClient
    let vault: SessionVault

    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var pinger: Task<Void, Never>?
    private var attempt = 0

    /// Milestone 5 §2: a monotonic local clock plus the fastest-RTT ping
    /// offset. Until the first pong the store falls back to the last state's
    /// `serverNow`, exactly as in Milestone 4.
    private let localClock: MonotonicClock
    private var clockSync = ClockOffsetEstimator()
    private var fallbackOffset: Double = 0
    private var pendingPings: [Int: Double] = [:]
    private var nextPingID = 0
    private var helloSent = false

    /// Binary media keyed by (game, round), exactly as the server pushes it.
    private var media: [MediaKey: MediaBlob] = [:]
    private var needMediaSent: Set<MediaKey> = []
    private var showingKey: MediaKey?
    /// Rounds whose media this device has decoded (§3), so it can ack and flip
    /// to the reveal locally at `revealAt`.
    private(set) var readyMedia: Set<MediaKey> = []
    private var probingMedia: Set<MediaKey> = []
    /// When the current reveal's media first appeared on screen (§4).
    private(set) var revealShownAt: Double?
    /// The key of a reveal this device started itself from a fixed countdown.
    /// Set by `RoomStore+FairReveal.swift`.
    @Published var localRevealKey: MediaKey?
    /// A pick made in a locally started reveal, held until the reveal state
    /// arrives so it can be sent with the elapsed time measured at the tap.
    /// It belongs to one (game, round): a stale pick is never sent.
    struct HeldGuess: Equatable {
        var targetID: String
        var elapsedMs: Double
        var game: Int
        var round: Int
    }
    /// Published so the avatar shows the pick selected while it is held.
    @Published var heldGuess: HeldGuess?
    var revealWatcher: Task<Void, Never>?

    /// The media showing in this reveal / results, kept so it can be saved.
    private(set) var savable: MediaBlob?

    /// A deck video playing inline under a pointer (hover), if any (§8).
    @Published private(set) var hoverItemID: String?
    private var hoverWork: Task<Void, Never>?

    /// The item this device bought in the open break, for the shop cards'
    /// "Bought ✓" / "One per break" captions (§6).
    @Published private(set) var lastBought: ShopItem?

    /// One processed item per kind held ready; the turn upload uses it at once.
    /// In Mix both kinds are kept warm, since the server says which kind a round is.
    private var prepared: [MediaKind: PreparedItem] = [:]
    private var work: Task<Void, Never>?
    private var lastSentDeck: DeckCount?
    /// The temporary file written for the reveal clip, deleted when it ends.
    private var revealFile: URL?

    static let muteDefaultsKey = "flashback.revealMuted"

    struct TurnRequest: Equatable {
        var slot: String
        var game: Int
        var round: Int
        var mode: MediaMode
        /// The kind the server wants; nil from older servers (random by mode).
        var kind: MediaKind? = nil
    }

    init(
        api: APIClient = APIClient(base: APIClient.defaultBase),
        vault: SessionVault = KeychainVault(),
        deck: DeckStore? = nil,
        clock: MonotonicClock = MonotonicClock()
    ) {
        self.api = api
        self.vault = vault
        self.deck = deck ?? DeckStore()
        self.localClock = clock
        self.playback.muted = UserDefaults.standard.object(forKey: Self.muteDefaultsKey) as? Bool ?? true
        self.deck.onChange = { [weak self] in
            self?.sendDeckIfNeeded()
            // A swap or New bunch can retire a prepared item: drop it and warm another.
            self?.prepareNext()
        }
    }

    /// `localNow + offset` (§2): every timer, effect and reveal reads this.
    var serverNow: Double { localClock.nowMs() + (clockSync.offset ?? fallbackOffset) }

    func setMuted(_ muted: Bool) {
        playback.muted = muted
        UserDefaults.standard.set(muted, forKey: Self.muteDefaultsKey)
    }

    // MARK: - Entering a room

    func resume() {
        guard session == nil, let saved = vault.resumable() else { return }
        enter(saved)
    }

    func create(nickname: String, clerkToken: String?) async {
        await run { try await self.api.createRoom(nickname: nickname, clerkToken: clerkToken) }
    }

    func join(code: String, nickname: String, clerkToken: String?) async {
        await run { try await self.api.joinRoom(code: code, nickname: nickname, clerkToken: clerkToken) }
    }

    private func run(_ action: @escaping () async throws -> RoomSession) async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do { enter(try await action()) } catch { self.error = error.localizedDescription }
    }

    func enter(_ session: RoomSession) {
        vault.save(session)
        self.session = session
        view = nil
        error = nil
        showJoin = false
        attempt = 0
        prepared.removeAll()
        lastSentDeck = nil
        media.removeAll()
        needMediaSent.removeAll()
        resetRevealState()
        pendingPings.removeAll()
        roomInfo = nil
        previewError = nil
        stopHover()
        playback.stop()
        deck.resetForNewRoom()
        connect()
    }

    /// Forgets locally derived reveal state (readiness, held pick, local flip).
    private func resetRevealState() {
        endLocalReveal()
        heldGuess = nil
        readyMedia.removeAll()
        probingMedia.removeAll()
        revealShownAt = nil
    }

    /// Handles join links: https://flashback.yoinklabs.dev/join/CODE and flashback://join/CODE.
    func open(url: URL) {
        guard let code = RoomCode.from(url: url) else { return }
        if session?.code == code { return }
        if let saved = vault.load(code: code), saved.isUsable() { return enter(saved) }
        draftCode = code
        showJoin = true
    }

    func leave() async {
        guard let session else { return }
        send(.leave)
        await api.leave(session: session)
        finish(reason: "removed")
    }

    func dismissClosed() {
        view = nil
        connection = .idle
        session = nil
    }

    private func finish(reason: String) {
        if let code = session?.code { vault.remove(code: code) }
        disconnect()
        clearReveal()
        stopHover()
        playback.stop()
        media.removeAll()
        needMediaSent.removeAll()
        resetRevealState()
        pendingPings.removeAll()
        prepared.removeAll()
        lastSentDeck = nil
        connection = .closed(reason)
    }

    // MARK: - Room preview

    /// Looks up a room before joining so the join screen can show host, mode,
    /// rounds, and how full it is.
    func preview(code: String) async {
        guard let normalized = RoomCode.normalize(code) else {
            roomInfo = nil
            previewError = nil
            previewLoading = false
            return
        }
        previewLoading = true
        previewError = nil
        do {
            let info = try await api.roomInfo(code: normalized)
            guard !Task.isCancelled else { return }
            roomInfo = info
            previewLoading = false
        } catch let error as APIError {
            guard !Task.isCancelled else { return }
            roomInfo = nil
            previewError = error.status == 404 ? "No room with that code" : error.message
            previewLoading = false
        } catch {
            guard !Task.isCancelled else { return }
            roomInfo = nil
            previewError = error.localizedDescription
            previewLoading = false
        }
    }

    func clearPreview() {
        roomInfo = nil
        previewError = nil
        previewLoading = false
    }

    // MARK: - WebSocket

    func connect() {
        guard let session else { return }
        disconnect()
        connection = attempt == 0 ? .connecting : .reconnecting
        let task = api.urlSession.webSocketTask(with: api.webSocketURL(code: session.code), protocols: ["flashback.v2", "auth.\(session.token)"])
        // The default 1 MB drops clips; a 16 MB ceiling covers an 8 MB MP4 frame.
        task.maximumMessageSize = MediaFrame.maxBytes
        socket = task
        task.resume()
        receiver = Task { [weak self] in await self?.receive(task) }
    }

    private func disconnect() {
        receiver?.cancel()
        pinger?.cancel()
        pinger = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        lastSentDeck = nil
        helloSent = false
        pendingPings.removeAll()
    }

    private func receive(_ task: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                if connection != .open {
                    connection = .open
                    attempt = 0
                }
                switch message {
                case .string(let text):
                    guard let data = text.data(using: .utf8),
                          let decoded = try? JSONDecoder().decode(ServerMessage.self, from: data) else { continue }
                    handle(decoded)
                case .data(let data):
                    handleMedia(data)
                default:
                    break
                }
            }
        } catch {
            guard !Task.isCancelled, socket === task, session != nil else { return }
            if case .closed = connection { return }
            attempt += 1
            connection = .reconnecting
            if attempt >= 3, let code = session?.code {
                do { _ = try await api.roomInfo(code: code) }
                catch let error as APIError where error.status == 404 { return finish(reason: "room-closed") }
                catch {}
            }
            if attempt >= 8 { return finish(reason: "lost") }
            try? await Task.sleep(for: .milliseconds(min(8000, 400 * (1 << attempt))))
            if socket === task { connect() }
        }
    }

    /// Applies one text message. Internal so tests can drive the store without a socket.
    func handle(_ message: ServerMessage) {
        switch message.type {
        case "state":
            guard let state = message.state else { return }
            registerFairReveal()
            // Until a pong lands, blend with the server's own clock (§2).
            if !clockSync.hasSample {
                fallbackOffset = state.serverNow - localClock.nowMs()
            }
            apply(state)
        case "pong":
            guard let id = message.id, let serverNow = message.serverNow,
                  let sentAt = pendingPings.removeValue(forKey: id) else { return }
            clockSync.record(sentAt: sentAt, receivedAt: localClock.nowMs(), serverNow: serverNow)
        case "error":
            // Errors from background messages (turn passes, deck counts, media
            // re-requests) must never show: only the round's owner could get them.
            if message.request == "buy" { lastBought = nil }
            if !["pass", "deck", "needMedia"].contains(message.request ?? "") { error = message.message }
        case "session":
            guard var session, let token = message.token, let expiresAt = message.expiresAt else { return }
            session.token = token
            session.expiresAt = expiresAt
            self.session = session
            vault.save(session)
        case "turn":
            guard let slot = message.slot, let game = message.game, let round = message.round, let mode = message.mode else { return }
            beginTurn(TurnRequest(slot: slot, game: game, round: round, mode: mode, kind: message.kind))
        case "closed":
            finish(reason: message.reason ?? "room-closed")
        default:
            break
        }
    }

    /// Sends `hello` and starts the ping schedule once per socket (§1, §2).
    /// Called after the first `state`, so the server already knows the player.
    private func registerFairReveal() {
        guard socket != nil, !helloSent else { return }
        helloSent = true
        send(.hello(ClientMessage.caps))
        startClockSync()
    }

    /// Five pings 200 ms apart, then one every 15 s (§2).
    private func startClockSync() {
        pinger?.cancel()
        pinger = Task { [weak self] in
            for _ in 0..<5 {
                guard let self, !Task.isCancelled else { return }
                self.sendPing()
                try? await Task.sleep(for: .milliseconds(200))
            }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                self.sendPing()
            }
        }
    }

    private func sendPing() {
        guard socket != nil else { return }
        nextPingID += 1
        let id = nextPingID
        pendingPings[id] = localClock.nowMs()
        // A dropped socket can't grow this without bound.
        if pendingPings.count > 32 {
            for old in pendingPings.keys.sorted().prefix(pendingPings.count - 32) {
                pendingPings.removeValue(forKey: old)
            }
        }
        send(.ping(id: id))
    }

    /// Applies a binary media frame. Internal so tests can drive it.
    func handleMedia(_ data: Data) {
        guard let frame = MediaFrame.parse(data) else { return }
        let key = MediaKey(game: frame.header.game, round: frame.header.round)
        let blob = MediaBlob(kind: frame.header.kind, bytes: frame.bytes)
        media[key] = blob
        // Decode it now, even if it is for the next round: the ack (§3) is
        // what lets the server fix the reveal time.
        probeMedia(key, blob)
        if let view, view.game == key.game, view.round?.index == key.round,
           view.phase == .reveal || localRevealKey == key {
            showReveal(key, kind: frame.header.kind)
            syncPlayback()
        }
    }

    /// Marks a round's media ready once it decodes: a photo synchronously, a
    /// clip by writing it out and asking AVFoundation whether it plays (§3).
    private func probeMedia(_ key: MediaKey, _ blob: MediaBlob) {
        guard !readyMedia.contains(key), !probingMedia.contains(key) else { return }
        switch blob.kind {
        case .photo:
            if UIImage(data: blob.bytes) != nil { markMediaReady(key) }
        case .video:
            probingMedia.insert(key)
            let bytes = blob.bytes
            Task { [weak self] in
                let ready = await Self.clipIsPlayable(bytes)
                guard let self else { return }
                self.probingMedia.remove(key)
                if ready { self.markMediaReady(key) }
            }
        }
    }

    nonisolated private static func clipIsPlayable(_ bytes: Data) async -> Bool {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("probe-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            try bytes.write(to: url, options: .completeFileProtection)
            let asset = AVURLAsset(url: url)
            guard try await asset.load(.isPlayable) else { return false }
            return try await !asset.loadTracks(withMediaType: .video).isEmpty
        } catch {
            return false
        }
    }

    /// Acks a round's media once per (game, round), then re-checks whether the
    /// fixed reveal time has passed.
    private func markMediaReady(_ key: MediaKey) {
        guard readyMedia.insert(key).inserted else { return }
        send(.mediaReady(round: key.round))
        _ = checkLocalReveal()
    }

    func apply(_ state: RoomView) {
        let old = view
        view = state
        let wasLocalReveal = localRevealKey != nil
        if state.phase != .countdown { endLocalReveal() }
        // The "Bought ✓" caption belongs to the open break; a pause keeps it.
        if state.phase != .results { lastBought = nil }
        deck.configure(state.settings, bunch: state.bunch)
        haptics(from: old, to: state, suppressingReveal: wasLocalReveal)
        sendDeckIfNeeded(force: lastSentDeck == nil)

        if state.phase != .lobby { stopHover() }

        switch state.phase {
        case .reveal:
            if let round = state.round {
                showReveal(MediaKey(game: state.game, round: round.index), kind: round.kind)
            }
            // A pick made during a locally started reveal goes out now, with the
            // elapsed time measured at the tap (§3, §4).
            flushHeldGuess()
        case .results:
            // A pick still waiting for a reveal that never came is stale.
            heldGuess = nil
            // Keep the last frame and the photo for the small results thumbnail,
            // and free every older round's bytes.
            if let ended = state.lastResult?.index {
                media = media.filter { $0.key.round > ended }
                readyMedia = readyMedia.filter { $0.round > ended }
                probingMedia = probingMedia.filter { $0.round > ended }
            }
        case .countdown:
            if let key = localRevealKey {
                // The countdown may be paused or restarted: unless its fixed
                // time is still in the past, go back to the countdown ring
                // ("clients always read revealAt from the latest view", §3).
                let stillLive = key.game == state.game
                    && key.round == state.round?.index
                    && !state.paused
                    && (state.round?.revealAt.map { serverNow >= $0 } ?? false)
                if stillLive {
                    showReveal(key, kind: state.round?.kind)
                } else {
                    endLocalReveal()
                    clearReveal()
                }
            } else {
                clearReveal()
            }
        case .lobby, .podium, .closed:
            heldGuess = nil
            clearReveal()
            media.removeAll()
            needMediaSent.removeAll()
            readyMedia.removeAll()
            probingMedia.removeAll()
        }

        syncLocalReveal()
        syncPlayback()

        // Keep prepared items warm; drop them only when they are no longer valid
        // for the room (unready, mode change, bunch change).
        if state.phase == .lobby, state.me?.ready != true {
            prepared.removeAll()
        }
        dropStalePrepared()
        if state.phase == .lobby, state.me?.ready == true {
            prepareNext()
        }
    }

    /// A prepared item is only good while it is still in a bunch the room uses.
    private func isCurrent(_ item: PreparedItem) -> Bool {
        deck.item(item.itemID) != nil && MediaConstraints.allows(view?.settings.mediaMode ?? .both, item.kind)
    }

    private func dropStalePrepared() {
        prepared = prepared.filter { isCurrent($0.value) }
    }

    /// The clip plays only in an unpaused reveal (including one this device
    /// started locally from the countdown); results and a pause hold its frame.
    /// Other purposes (deck preview, hover) are never touched.
    func syncPlayback() {
        guard playback.clip?.purpose == .reveal else { return }
        let revealed = view?.phase == .reveal || localRevealKey != nil
        if revealed && view?.paused == false { playback.resume() } else { playback.pause() }
    }

    private func haptics(from old: RoomView?, to new: RoomView, suppressingReveal: Bool = false) {
        if old?.me?.ready == false && new.me?.ready == true { Haptics.ready() }
        guard old?.phase != new.phase || old?.round?.index != new.round?.index else { return }
        switch new.phase {
        case .countdown: Haptics.tick()
        case .reveal: if !suppressingReveal { Haptics.reveal() }
        case .results:
            if let row = new.lastResult?.rows.first(where: { $0.playerID == new.you.id }) {
                if row.correct { Haptics.correct() } else { Haptics.incorrect() }
            }
        case .podium: Haptics.podium()
        default: break
        }
    }

    func send(_ message: ClientMessage) {
        guard let socket, let data = try? JSONEncoder().encode(message), let text = String(data: data, encoding: .utf8) else { return }
        let isPing = message.isPing
        if !isPing { error = nil }
        socket.send(.string(text)) { [weak self] failure in
            guard failure != nil, !isPing else { return }
            Task { @MainActor in self?.error = "Reconnecting… try again in a moment." }
        }
    }

    func setReady(_ ready: Bool) {
        send(.ready(ready))
        if ready { prepareNext() }
    }

    // MARK: - Deck counts

    private func sendDeckIfNeeded(force: Bool = false) {
        guard socket != nil, let view else { return }
        let counts = deck.counts(mode: view.settings.mediaMode)
        guard force || counts != lastSentDeck else { return }
        lastSentDeck = counts
        send(.deck(counts))
    }

    // MARK: - Turn uploads (silent: nothing in the UI hints whose turn it is)

    /// Queued in order: the server can ask for two slots at once (lookahead 2),
    /// and each one must get exactly one answer.
    private func beginTurn(_ turn: TurnRequest) {
        enqueue { [weak self] in
            guard let self, self.session != nil else { return }
            await self.serve(turn)
        }
    }

    /// Runs preparation and uploads one at a time so a turn never races a prep.
    private func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let previous = work
        work = Task { @MainActor in
            if let previous { await previous.value }
            await operation()
        }
    }

    private func prepareNext() {
        dropStalePrepared()
        guard let view, session != nil else { return }
        guard view.phase != .lobby || view.me?.ready == true else { return }
        let mode = view.settings.mediaMode
        for kind in DeckState.kinds(mode) where prepared[kind] == nil {
            enqueue { [weak self] in
                guard let self, self.session != nil else { return }
                self.dropStalePrepared()
                guard self.prepared[kind] == nil else { return }
                // The item can be swapped out while it is being processed: try once more.
                for _ in 0..<2 {
                    guard let item = await self.processNext(mode: mode, kind: kind) else { break }
                    if self.isCurrent(item) {
                        self.prepared[kind] = item
                        break
                    }
                }
            }
        }
    }

    private func processNext(mode: MediaMode, kind: MediaKind?) async -> PreparedItem? {
        var attempts = 0
        while attempts < 6 {
            attempts += 1
            guard let item = deck.randomCandidate(mode: mode, kind: kind) else { return nil }
            do {
                return try await deck.prepare(item)
            } catch {
                // A bad item is burned so the next attempt makes progress.
                deck.markUsed(item.id)
            }
        }
        return nil
    }

    /// The warm item for this turn: the asked-for kind, or (older servers) a
    /// random allowed kind.
    private func currentPrepared(mode: MediaMode, kind: MediaKind?) -> PreparedItem? {
        dropStalePrepared()
        if let kind { return prepared[kind] }
        return DeckState.kinds(mode).compactMap { prepared[$0] }.randomElement()
    }

    private func serve(_ turn: TurnRequest) async {
        guard let session else {
            send(.pass(turn.slot))
            return
        }

        var uploaded = false
        var shouldPass = true
        var attempts = 0
        while attempts < 3 && !uploaded {
            attempts += 1
            let item: PreparedItem?
            if let ready = currentPrepared(mode: turn.mode, kind: turn.kind) {
                item = ready
            } else {
                item = await processNext(mode: turn.mode, kind: turn.kind)
            }
            guard let item else { break }
            prepared[item.kind] = nil
            do {
                try await api.upload(item.data, kind: item.kind, slot: turn.slot, session: session)
                // The owner keeps its own copy under the same (game, round) key,
                // decoded like any other so it can flip to the reveal at
                // `revealAt` too (an owner's ack is ignored by the server).
                let key = MediaKey(game: turn.game, round: turn.round)
                let blob = MediaBlob(kind: item.kind, bytes: item.data)
                media[key] = blob
                probeMedia(key, blob)
                deck.markUsed(item.itemID)
                uploaded = true
            } catch let error as APIError where error.status == 409 {
                // The slot was already answered, reassigned, or timed out.
                // Passing for it would be wrong, so stop quietly.
                shouldPass = false
                break
            } catch {
                deck.markUsed(item.itemID)
            }
        }

        if !uploaded && shouldPass { send(.pass(turn.slot)) }
        prepareNext()
    }

    // MARK: - Reveal media

    private var hasMedia: Bool {
        revealImage != nil || (playback.clip?.purpose == .reveal && playback.isLoaded)
    }

    func showReveal(_ key: MediaKey, kind: MediaKind?) {
        if showingKey == key {
            if let blob = media[key], !hasMedia { present(blob) }
            return
        }
        clearReveal()
        showingKey = key
        if let blob = media[key] {
            present(blob)
            return
        }
        // Ask once. If the Durable Object lost the bytes, say so plainly.
        if needMediaSent.insert(key).inserted { send(.needMedia(key.round)) }
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(2200))
            guard let self, self.showingKey == key, !self.hasMedia else { return }
            self.revealFailed = true
        }
    }

    private func present(_ blob: MediaBlob) {
        revealFailed = false
        savable = blob
        switch blob.kind {
        case .photo:
            guard let image = UIImage(data: blob.bytes) else {
                revealFailed = true
                return
            }
            revealImage = image
        case .video:
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("reveal-\(UUID().uuidString).mp4")
            do {
                try blob.bytes.write(to: url, options: .completeFileProtection)
            } catch {
                revealFailed = true
                return
            }
            revealFile = url
            // The one shared player (§8); the reveal is the clip's purpose.
            playback.play(file: url, loop: true, purpose: .reveal, id: "reveal-\(showingKey?.round ?? 0)")
            syncPlayback()
        }
        // Shown for the first time: the base of this round's elapsed time (§4).
        if revealShownAt == nil { revealShownAt = serverNow }
        if let key = showingKey { markMediaReady(key) }
    }

    private func clearReveal() {
        showingKey = nil
        savable = nil
        revealImage = nil
        revealFailed = false
        revealShownAt = nil
        playback.stop(purpose: .reveal)
        if let revealFile {
            try? FileManager.default.removeItem(at: revealFile)
            self.revealFile = nil
        }
    }

    // MARK: - Inline deck preview (shared player, §8)

    /// Hovering a video tile for 250 ms plays it inline, muted, on a pointer
    /// device. Leaving stops it. Never touches a reveal or the full preview.
    func beginHoverPreview(_ item: DeckItem) {
        guard item.kind == .video, session != nil else { return }
        stopHover()
        hoverItemID = item.id
        hoverWork = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self, !Task.isCancelled, self.hoverItemID == item.id else { return }
            guard let playerItem = await self.deck.playerItem(for: item) else { return }
            guard !Task.isCancelled, self.hoverItemID == item.id else { return }
            self.playback.play(playerItem, loop: true, forcedMuted: true, purpose: .hover, id: item.id)
        }
    }

    func endHoverPreview(_ id: String) {
        guard hoverItemID == id else { return }
        stopHover()
    }

    private func stopHover() {
        hoverWork?.cancel()
        hoverWork = nil
        hoverItemID = nil
        playback.stop(purpose: .hover)
    }

    // MARK: - Power-ups (§5, §6)

    /// A 50/50 can be used before guessing in an unpaused reveal, with a charge
    /// in hand and not already used this round. The wrong-choice pool excludes
    /// the owner and the viewer; the owner is hidden until results, so the
    /// client applies the stricter non-owner rule (4+ players).
    var canUseFiftyFifty: Bool {
        guard let view, view.phase == .reveal, !view.paused, view.canGuess else { return false }
        guard (view.me?.items.fiftyFifty ?? 0) > 0 else { return false }
        guard view.round?.yourGuess == nil else { return false }
        guard view.round?.eliminated.isEmpty != false else { return false }
        return FiftyFiftyRules.canCut(players: view.players.count, isOwner: false)
    }

    func useFiftyFifty() {
        guard canUseFiftyFifty else {
            Haptics.denied()
            return
        }
        Haptics.tick()
        send(.useFiftyFifty)
    }

    /// Buys one shop item. The server owns the price, the score, and the
    /// once-per-break rule; the disabled cards never reach here.
    func buy(_ item: ShopItem) {
        guard let view, let shop = view.activeShop, shop.open, !shop.bought, !view.paused else { return }
        guard ShopAvailability.evaluate(item: item, player: view.me, shop: shop) == .available else {
            Haptics.denied()
            return
        }
        lastBought = item
        Haptics.tick()
        send(.buy(item))
    }

    // MARK: - Host controls

    func pause() {
        guard view?.isHost == true, view?.canPause == true else { return }
        Haptics.tick()
        send(.pause)
    }

    func resumeGame() {
        guard view?.isHost == true, view?.paused == true else { return }
        Haptics.ready()
        send(.resume)
    }

    // MARK: - Save and toasts

    var canSave: Bool {
        let revealed = view?.phase == .reveal || view?.phase == .results || localRevealKey != nil
        return savable != nil && revealed
    }

    /// Saves this round's photo or clip to the player's library (add-only access).
    /// Local only: it uses the bytes already on the phone.
    func saveCurrentMedia() async {
        guard let blob = savable, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            try await MediaSaver.save(blob)
            Haptics.saved()
            show(Toast(text: blob.kind == .video ? "Clip saved" : "Saved", symbol: "checkmark.circle.fill"))
        } catch {
            Haptics.incorrect()
            let denied = (error as? MediaSaver.SaveError) == .denied
            show(Toast(text: error.localizedDescription, symbol: "exclamationmark.triangle.fill", isError: true, action: denied ? .openSettings : nil))
        }
    }

    func copyCode() {
        guard let code = view?.code else { return }
        UIPasteboard.general.string = code
        Haptics.tick()
        show(Toast(text: "Code copied", symbol: "doc.on.doc.fill"))
    }

    func show(_ toast: Toast) {
        self.toast = toast
        let id = toast.id
        Task { [weak self] in
            try? await Task.sleep(for: toast.duration)
            if self?.toast?.id == id { self?.toast = nil }
        }
    }

    #if DEBUG
    /// Screenshot fixtures: a room with no server or socket.
    func debugLoad(_ state: RoomView, media: MediaBlob? = nil) {
        session = RoomSession(code: state.code, playerID: state.you.id, nickname: state.me?.nickname ?? "You", token: "debug", expiresAt: 4_000_000_000, joinURL: RoomCode.joinURL(state.code).absoluteString)
        connection = .open
        // Fixtures run on this device's clock, with no socket to sync against.
        clockSync.reset()
        fallbackOffset = state.serverNow - localClock.nowMs()
        if let media, let round = state.round?.index {
            let key = MediaKey(game: state.game, round: round)
            self.media[key] = media
            probeMedia(key, media)
        }
        apply(state)
    }
    #endif
}
