import AVFoundation
import Foundation
import SwiftUI
import UIKit

/// Looping, muted-by-default playback for the current reveal. Owned by the
/// store (not a view) so folding or rotating never restarts or loses it. Each
/// clip gets a fresh player so no state from an earlier round can linger.
@MainActor final class PlaybackController: ObservableObject {
    @Published private(set) var player: AVQueuePlayer?
    @Published var muted = true { didSet { player?.isMuted = muted } }
    private var looper: AVPlayerLooper?
    private var file: URL?

    func play(file url: URL) {
        stop()
        file = url
        let player = AVQueuePlayer()
        player.isMuted = muted
        player.preventsDisplaySleepDuringVideoPlayback = true
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        self.player = player
        player.play()
    }

    /// Keeps the last frame visible (used on the results screen).
    func pause() {
        player?.pause()
    }

    func stop() {
        player?.pause()
        looper?.disableLooping()
        looper = nil
        player?.removeAllItems()
        player = nil
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
    }
}

enum Connection: Equatable { case idle, connecting, open, reconnecting, closed(String) }

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

    let deck: DeckStore
    let playback = PlaybackController()

    var api: APIClient
    let vault: SessionVault

    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var pinger: Task<Void, Never>?
    private var attempt = 0
    private var clockOffset: Double = 0

    /// Binary media keyed by (game, round), exactly as the server pushes it.
    private var media: [MediaKey: MediaBlob] = [:]
    private var needMediaSent: Set<MediaKey> = []
    private var showingKey: MediaKey?

    /// One processed item held ready. The turn upload uses it instantly.
    private var prepared: PreparedItem?
    private var work: Task<Void, Never>?
    private var lastSentDeck: DeckCount?

    static let muteDefaultsKey = "flashback.revealMuted"

    struct TurnRequest: Equatable {
        var slot: String
        var game: Int
        var round: Int
        var mode: MediaMode
    }

    init(
        api: APIClient = APIClient(base: APIClient.defaultBase),
        vault: SessionVault = KeychainVault(),
        deck: DeckStore? = nil
    ) {
        self.api = api
        self.vault = vault
        self.deck = deck ?? DeckStore()
        self.playback.muted = UserDefaults.standard.object(forKey: Self.muteDefaultsKey) as? Bool ?? true
        self.deck.onChange = { [weak self] in self?.sendDeckIfNeeded() }
    }

    var serverNow: Double { Date().timeIntervalSince1970 * 1000 + clockOffset }

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
        prepared = nil
        lastSentDeck = nil
        media.removeAll()
        needMediaSent.removeAll()
        roomInfo = nil
        previewError = nil
        deck.resetUsed()
        connect()
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
        media.removeAll()
        needMediaSent.removeAll()
        prepared = nil
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
        pinger = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                self?.send(.ping)
            }
        }
    }

    private func disconnect() {
        receiver?.cancel()
        pinger?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        lastSentDeck = nil
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
            clockOffset = state.serverNow - Date().timeIntervalSince1970 * 1000
            apply(state)
        case "error":
            // Errors from background messages (turn passes, deck counts, media
            // re-requests) must never show: only the round's owner could get them.
            if !["pass", "deck", "needMedia"].contains(message.request ?? "") { error = message.message }
        case "session":
            guard var session, let token = message.token, let expiresAt = message.expiresAt else { return }
            session.token = token
            session.expiresAt = expiresAt
            self.session = session
            vault.save(session)
        case "turn":
            guard let slot = message.slot, let game = message.game, let round = message.round, let mode = message.mode else { return }
            beginTurn(TurnRequest(slot: slot, game: game, round: round, mode: mode))
        case "closed":
            finish(reason: message.reason ?? "room-closed")
        default:
            break
        }
    }

    /// Applies a binary media frame. Internal so tests can drive it.
    func handleMedia(_ data: Data) {
        guard let frame = MediaFrame.parse(data) else { return }
        let key = MediaKey(game: frame.header.game, round: frame.header.round)
        media[key] = MediaBlob(kind: frame.header.kind, bytes: frame.bytes)
        if let view, view.phase == .reveal, view.game == key.game, view.round?.index == key.round {
            showReveal(key, kind: frame.header.kind)
        }
    }

    func apply(_ state: RoomView) {
        let old = view
        view = state
        haptics(from: old, to: state)
        sendDeckIfNeeded(force: lastSentDeck == nil)

        switch state.phase {
        case .reveal:
            if let round = state.round {
                showReveal(MediaKey(game: state.game, round: round.index), kind: round.kind)
            }
        case .results:
            // Keep the last frame and the photo for the small results thumbnail,
            // and free every older round's bytes.
            playback.pause()
            if let ended = state.lastResult?.index {
                media = media.filter { $0.key.round > ended }
            }
        default:
            clearReveal()
            if state.phase == .lobby || state.phase == .podium {
                media.removeAll()
                needMediaSent.removeAll()
            }
        }

        // Keep a prepared item warm; drop it only when it is no longer valid for
        // the room (unready, mode change, deck change).
        if state.phase == .lobby, state.me?.ready != true {
            prepared = nil
        }
        if let current = prepared {
            let stillInDeck = deck.item(current.itemID) != nil
            if !stillInDeck || !MediaConstraints.allows(state.settings.mediaMode, current.kind) {
                prepared = nil
            }
        }
        if state.phase == .lobby, state.me?.ready == true {
            prepareNext()
        }
    }

    private func haptics(from old: RoomView?, to new: RoomView) {
        if old?.me?.ready == false && new.me?.ready == true { Haptics.ready() }
        guard old?.phase != new.phase || old?.round?.index != new.round?.index else { return }
        switch new.phase {
        case .countdown: Haptics.tick()
        case .reveal: Haptics.reveal()
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
        guard prepared == nil, let view, session != nil else { return }
        guard view.phase != .lobby || view.me?.ready == true else { return }
        let mode = view.settings.mediaMode
        enqueue { [weak self] in
            guard let self, self.session != nil, self.prepared == nil else { return }
            self.prepared = await self.processNext(mode: mode)
        }
    }

    private func processNext(mode: MediaMode) async -> PreparedItem? {
        var attempts = 0
        while attempts < 6 {
            attempts += 1
            guard let item = deck.randomCandidate(mode: mode) else { return nil }
            do {
                return try await deck.prepare(item)
            } catch {
                // A bad item is burned so the next attempt makes progress.
                deck.markUsed(item.id)
            }
        }
        return nil
    }

    private func currentPrepared(mode: MediaMode) -> PreparedItem? {
        guard let prepared else { return nil }
        guard let item = deck.item(prepared.itemID),
              !deck.isHidden(item.id),
              MediaConstraints.allows(mode, prepared.kind) else {
            self.prepared = nil
            return nil
        }
        return prepared
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
            if let ready = currentPrepared(mode: turn.mode) {
                item = ready
            } else {
                item = await processNext(mode: turn.mode)
            }
            guard let item else { break }
            prepared = nil
            do {
                try await api.upload(item.data, kind: item.kind, slot: turn.slot, session: session)
                // The owner keeps its own copy under the same (game, round) key.
                media[MediaKey(game: turn.game, round: turn.round)] = MediaBlob(kind: item.kind, bytes: item.data)
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

    private var hasMedia: Bool { revealImage != nil || playback.player != nil }

    private func showReveal(_ key: MediaKey, kind: MediaKind?) {
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
            playback.play(file: url)
        }
    }

    private func clearReveal() {
        showingKey = nil
        revealImage = nil
        revealFailed = false
        playback.stop()
    }
}
