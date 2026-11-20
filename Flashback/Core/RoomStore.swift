import AVFoundation
import Photos
import PhotosUI
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

struct UploadStatus: Identifiable, Equatable {
    let id = UUID()
    var label: String
    var state: String
    var failed = false
}

/// All room state for the app: session, server view, connection, reveal media,
/// uploads, and form drafts. Views are pure functions of this store.
@MainActor final class RoomStore: ObservableObject {
    @Published private(set) var session: RoomSession?
    @Published private(set) var view: RoomView?
    @Published private(set) var connection: Connection = .idle
    @Published var error: String?
    @Published var busy = false
    @Published var uploads: [UploadStatus] = []
    @Published var revealImage: UIImage?
    @Published var revealFailed = false
    @Published var draftCode = ""
    @Published var draftNickname = ""
    @Published var showJoin = false
    let playback = PlaybackController()

    var api: APIClient
    let vault: SessionVault
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var pinger: Task<Void, Never>?
    private var attempt = 0
    private var clockOffset: Double = 0
    private var revealPath: String?

    init(api: APIClient = APIClient(base: APIClient.defaultBase), vault: SessionVault = KeychainVault()) {
        self.api = api
        self.vault = vault
    }

    var serverNow: Double { Date().timeIntervalSince1970 * 1000 + clockOffset }

    // ---- entering a room ----

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
        busy = true; error = nil
        defer { busy = false }
        do { enter(try await action()) } catch { self.error = error.localizedDescription }
    }

    func enter(_ session: RoomSession) {
        vault.save(session)
        self.session = session
        showJoin = false
        attempt = 0
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
        connection = .closed(reason)
    }

    // ---- WebSocket ----

    func connect() {
        guard let session else { return }
        disconnect()
        connection = attempt == 0 ? .connecting : .reconnecting
        let task = api.urlSession.webSocketTask(with: api.webSocketURL(code: session.code), protocols: ["flashback.v1", "auth.\(session.token)"])
        socket = task
        task.resume()
        receiver = Task { [weak self] in await self?.receive(task) }
        pinger = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                self?.send(.ping)
            }
        }
    }

    private func disconnect() {
        receiver?.cancel(); pinger?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
    }

    private func receive(_ task: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                guard case .string(let text) = message, let data = text.data(using: .utf8) else { continue }
                if connection != .open { connection = .open; attempt = 0 }
                handle(try JSONDecoder().decode(ServerMessage.self, from: data))
            }
        } catch {
            guard !Task.isCancelled, socket === task, session != nil else { return }
            if case .closed = connection { return }
            attempt += 1
            connection = .reconnecting
            if attempt >= 3, let code = session?.code {
                do { _ = try await api.roomInfo(code: code) } catch let e as APIError where e.status == 404 { return finish(reason: "room-closed") } catch {}
            }
            if attempt >= 8 { return finish(reason: "lost") }
            try? await Task.sleep(for: .milliseconds(min(8000, 400 * (1 << attempt))))
            if socket === task { connect() }
        }
    }

    /// Applies one server message. Internal so tests can drive the store without a socket.
    func handle(_ message: ServerMessage) {
        switch message.type {
        case "state":
            guard let state = message.state else { return }
            clockOffset = state.serverNow - Date().timeIntervalSince1970 * 1000
            apply(state)
        case "error": error = message.message
        case "session":
            guard var session, let token = message.token, let expiresAt = message.expiresAt else { return }
            session.token = token; session.expiresAt = expiresAt
            self.session = session
            vault.save(session)
        case "closed": finish(reason: message.reason ?? "room-closed")
        default: break
        }
    }

    func apply(_ state: RoomView) {
        let old = view
        view = state
        haptics(from: old, to: state)
        if state.phase == .reveal, let path = state.round?.mediaPath, let kind = state.round?.kind {
            if path != revealPath { loadReveal(path: path, kind: kind) }
        } else if revealPath != nil {
            // The round ended: drop the media from memory and disk right away.
            clearReveal()
        }
    }

    private func haptics(from old: RoomView?, to new: RoomView) {
        guard old?.phase != new.phase || old?.round?.index != new.round?.index else {
            if old?.me?.ready == false && new.me?.ready == true { Haptics.ready() }
            return
        }
        switch new.phase {
        case .countdown: Haptics.tick()
        case .reveal: Haptics.reveal()
        case .results:
            if let row = new.lastResult?.rows.first(where: { $0.playerID == new.you.id }) { row.correct ? Haptics.correct() : Haptics.incorrect() }
        case .podium: Haptics.podium()
        default: break
        }
    }

    func send(_ message: ClientMessage) {
        guard let socket, let data = try? JSONEncoder().encode(message), let text = String(data: data, encoding: .utf8) else { return }
        if case .ping = message {} else { error = nil }
        socket.send(.string(text)) { [weak self] failure in
            if failure != nil, case .ping = message {} else if failure != nil { Task { @MainActor in self?.error = "Reconnecting… try again in a moment." } }
        }
    }

    // ---- reveal media ----

    private func loadReveal(path: String, kind: MediaKind) {
        clearReveal()
        revealPath = path
        guard let session else { return }
        Task {
            do {
                let data = try await api.media(path: path, session: session)
                guard revealPath == path else { return }
                if kind == .photo { revealImage = UIImage(data: data) }
                else {
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("reveal-\(UUID().uuidString).mp4")
                    try data.write(to: url, options: .completeFileProtection)
                    playback.play(file: url)
                }
            } catch { if revealPath == path { revealFailed = true } }
        }
    }

    private func clearReveal() {
        revealPath = nil
        revealImage = nil
        revealFailed = false
        playback.stop()
    }

    // ---- adding media ----

    private var slots: Int { MediaConstraints.slots(used: view?.you.items.count ?? 0) }

    /// "Pick for me": random photos and/or videos from the library via PhotoKit.
    func addRandom() async {
        guard let mode = view?.settings.mediaMode else { return }
        let access = await MediaLibrary.requestAccess()
        guard access != .denied else { error = MediaError.noAccess.localizedDescription; return }
        let assets = MediaLibrary.randomAssets(mode: mode, count: min(slots, MediaConstraints.randomBatch))
        guard !assets.isEmpty else { error = MediaError.nothingFound(mode).localizedDescription; return }
        await process(assets.map { asset in
            (asset.mediaType == .video ? MediaKind.video : .photo, { () async throws -> Prepared in
                asset.mediaType == .video ? .file(try await MediaProcessor.clip(from: try await MediaProcessor.avAsset(from: asset))) : .data(try await MediaProcessor.photo(from: asset))
            })
        })
    }

    /// Items the player chose with the system photo picker (no library permission needed).
    func add(picked items: [PhotosPickerItem]) async {
        await process(items.prefix(slots).map { item in
            let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
            return (isVideo ? MediaKind.video : .photo, { () async throws -> Prepared in
                if isVideo {
                    guard let movie = try await item.loadTransferable(type: PickedMovie.self) else { throw MediaError.unreadable }
                    defer { try? FileManager.default.removeItem(at: movie.url) }
                    return .file(try await MediaProcessor.clip(from: AVURLAsset(url: movie.url)))
                }
                guard let data = try await item.loadTransferable(type: Data.self) else { throw MediaError.unreadable }
                return .data(try MediaProcessor.compressPhoto(data))
            })
        })
    }

    enum Prepared { case data(Data), file(URL) }

    private func process(_ jobs: [(MediaKind, () async throws -> Prepared)]) async {
        guard let mode = view?.settings.mediaMode else { return }
        uploads = jobs.enumerated().map { UploadStatus(label: $0.element.0 == .photo ? "Photo \($0.offset + 1)" : "Video \($0.offset + 1)", state: "Waiting…") }
        for (index, job) in jobs.enumerated() {
            let (kind, prepare) = job
            do {
                guard MediaConstraints.allows(mode, kind) else { throw MediaError.notAllowed(mode) }
                uploads[index].state = kind == .photo ? "Compressing…" : "Making a short clip…"
                let prepared = try await prepare()
                let data: Data
                switch prepared {
                case .data(let d): data = d
                case .file(let url):
                    defer { try? FileManager.default.removeItem(at: url) }
                    data = try Data(contentsOf: url)
                }
                try MediaConstraints.validate(bytes: data.count, kind: kind)
                uploads[index].state = "Uploading…"
                guard let session else { return }
                try await api.upload(data, kind: kind, session: session)
                uploads[index].state = "Added"
            } catch {
                uploads[index].state = error.localizedDescription
                uploads[index].failed = true
            }
        }
        try? await Task.sleep(for: .seconds(2))
        uploads.removeAll { !$0.failed }
    }
}

/// A picked movie copied to a temporary file we own (and delete).
struct PickedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent("picked-\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return Self(url: copy)
        }
    }
}
