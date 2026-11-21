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
    private var clockOffset: Double = 0

    /// Binary media keyed by (game, round), exactly as the server pushes it.
    private var media: [MediaKey: MediaBlob] = [:]
    private var needMediaSent: Set<MediaKey> = []
    private var showingKey: MediaKey?

    /// The media showing in this reveal / results, kept so it can be saved.
    private(set) var savable: MediaBlob?

    /// One processed item per kind held ready; the turn upload uses it at once.
    /// In Mix both kinds are kept warm, since the server says which kind a round is.
    private var prepared: [MediaKind: PreparedItem] = [:]
    private var work: Task<Void, Never>?
    private var lastSentDeck: DeckCount?

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
        deck: DeckStore? = nil
    ) {
        self.api = api
        self.vault = vault
        self.deck = deck ?? DeckStore()
        self.playback.muted = UserDefaults.standard.object(forKey: Self.muteDefaultsKey) as? Bool ?? true
        self.deck.onChange = { [weak self] in
            self?.sendDeckIfNeeded()
            // A swap or New bunch can retire a prepared item: drop it and warm another.
            self?.prepareNext()
        }
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
        prepared.removeAll()
        lastSentDeck = nil
        media.removeAll()
        needMediaSent.removeAll()
        roomInfo = nil
        previewError = nil
        deck.resetForNewRoom()
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
            beginTurn(TurnRequest(slot: slot, game: game, round: round, mode: mode, kind: message.kind))
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
        deck.configure(state.settings)
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

    /// The clip plays only in an unpaused reveal; results and a pause hold its frame.
    private func syncPlayback() {
        if view?.phase == .reveal && view?.paused == false { playback.resume() } else { playback.pause() }
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
            playback.play(file: url)
            syncPlayback()
        }
    }

    private func clearReveal() {
        showingKey = nil
        savable = nil
        revealImage = nil
        revealFailed = false
        playback.stop()
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

    var canSave: Bool { savable != nil && (view?.phase == .reveal || view?.phase == .results) }

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
        clockOffset = state.serverNow - Date().timeIntervalSince1970 * 1000
        if let media, let round = state.round?.index {
            self.media[MediaKey(game: state.game, round: round)] = media
        }
        apply(state)
    }
    #endif
}
