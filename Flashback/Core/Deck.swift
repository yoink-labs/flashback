import AVFoundation
import Photos
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// The deck is the local, visible set of photos and videos a player is willing
// to show. It never leaves the phone: the server only learns how many items fit
// the room's media mode, and only the one item picked for a round is uploaded.

struct DeckItem: Identifiable, Equatable {
    enum Origin: Equatable {
        case library(String)
        case picked
    }

    var id: String
    var kind: MediaKind
    /// PhotoKit local identifier when this came from the library.
    var assetID: String?
    /// Compressed JPEG bytes for an item chosen with the system picker.
    var photoData: Data?
    /// Temporary MP4 for an item chosen with the system picker.
    var videoFile: URL?
    /// Seconds, for the duration badge.
    var duration: Double?
    var origin: Origin

    static func library(_ asset: PHAsset) -> DeckItem {
        let video = asset.mediaType == .video
        return DeckItem(
            id: asset.localIdentifier,
            kind: video ? .video : .photo,
            assetID: asset.localIdentifier,
            photoData: nil,
            videoFile: nil,
            duration: video ? asset.duration : nil,
            origin: .library(asset.localIdentifier)
        )
    }

    var durationLabel: String? {
        guard kind == .video, let duration, duration.isFinite, duration > 0 else { return nil }
        let total = Int(duration.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// Pure deck logic: visible/hidden/used filtering by media mode. Unit tested.
struct DeckState: Equatable {
    static let size = 24

    var items: [DeckItem]
    var hidden: Set<String>
    var used: Set<String>

    init(items: [DeckItem] = [], hidden: Set<String> = [], used: Set<String> = []) {
        self.items = items
        self.hidden = hidden
        self.used = used
    }

    func fitting(_ mode: MediaMode) -> [DeckItem] {
        items.filter { MediaConstraints.allows(mode, $0.kind) }
    }

    /// Unhidden items that fit the mode. Hidden items are never uploaded.
    func visible(_ mode: MediaMode) -> [DeckItem] {
        fitting(mode).filter { !hidden.contains($0.id) }
    }

    func counts(_ mode: MediaMode) -> DeckCount {
        let visible = visible(mode)
        return DeckCount(
            photos: visible.filter { $0.kind == .photo }.count,
            videos: visible.filter { $0.kind == .video }.count
        )
    }

    func isHidden(_ id: String) -> Bool { hidden.contains(id) }

    func item(_ id: String) -> DeckItem? { items.first { $0.id == id } }

    /// Unused, visible items that fit the mode; when every item has been shown
    /// this session the deck is allowed to start over.
    func candidates(_ mode: MediaMode) -> [DeckItem] {
        let visible = visible(mode)
        let unused = visible.filter { !used.contains($0.id) }
        return unused.isEmpty ? visible : unused
    }

    mutating func setHidden(_ id: String, _ hidden: Bool) {
        if hidden { self.hidden.insert(id) } else { self.hidden.remove(id) }
    }

    mutating func markUsed(_ id: String) {
        used.insert(id)
    }

    mutating func add(_ newItems: [DeckItem]) {
        let existing = Set(items.map(\.id))
        items.append(contentsOf: newItems.filter { !existing.contains($0.id) })
    }

    /// "Shuffle again" swaps the library picks and keeps items the player added by hand.
    mutating func replaceLibrary(_ newItems: [DeckItem]) {
        items = items.filter { $0.origin == .picked } + newItems
    }
}

/// A processed item held in memory, ready to upload the moment it is asked for.
struct PreparedItem: Equatable {
    var itemID: String
    var kind: MediaKind
    var data: Data
}

/// Owns the player's deck, its thumbnails, and on-demand processing. Reset-free:
/// the deck lives here so folding, rotating, or leaving the lobby never loses it.
@MainActor final class DeckStore: ObservableObject {
    static let hiddenDefaultsKey = "flashback.hiddenAssets"

    @Published private(set) var state: DeckState
    @Published private(set) var loading = false
    @Published private(set) var note: String?

    /// Called after the deck changes so `RoomStore` can report the new counts.
    var onChange: (@MainActor () -> Void)?

    private let defaults: UserDefaults
    /// Hidden library identifiers, remembered across games on this device.
    private var hiddenAssets: Set<String>
    private let manager = PHCachingImageManager()
    private let thumbnails = NSCache<NSString, UIImage>()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let hidden = Set(defaults.stringArray(forKey: Self.hiddenDefaultsKey) ?? [])
        self.hiddenAssets = hidden
        self.state = DeckState(hidden: hidden)
    }

    var items: [DeckItem] { state.items }
    var used: Set<String> { state.used }
    var isShuffling: Bool { loading }

    func counts(mode: MediaMode) -> DeckCount { state.counts(mode) }
    func isHidden(_ id: String) -> Bool { state.isHidden(id) }
    func item(_ id: String) -> DeckItem? { state.item(id) }

    func markUsed(_ id: String) {
        guard !state.used.contains(id) else { return }
        state.markUsed(id)
        notify()
    }

    /// A new room starts the "already shown this session" bookkeeping over.
    func resetUsed() {
        guard !state.used.isEmpty else { return }
        state.used.removeAll()
        notify()
    }

    // MARK: - Building the deck

    func shuffle(mode: MediaMode) async {
        guard !loading else { return }
        loading = true
        note = nil
        defer { loading = false }

        let access = MediaLibrary.currentAccess == .denied ? await MediaLibrary.requestAccess() : MediaLibrary.currentAccess
        guard access != .denied else {
            note = MediaError.noAccess.localizedDescription
            return
        }
        let excluding = hiddenAssets.union(state.items.filter { $0.origin != .picked }.map(\.id))
        let assets = MediaLibrary.randomAssets(mode: mode, count: DeckState.size, excluding: excluding)
        let fresh = assets.map(DeckItem.library)
        guard !fresh.isEmpty else {
            note = MediaError.nothingFound(mode).localizedDescription
            return
        }
        state.replaceLibrary(fresh)
        notify()
    }

    /// "Add specific…" from the system photo picker. Needs no library permission.
    func addPicked(_ picked: [PhotosPickerItem], mode: MediaMode) async {
        guard !picked.isEmpty, !loading else { return }
        loading = true
        note = nil
        defer { loading = false }

        var added: [DeckItem] = []
        for pick in picked.prefix(DeckState.size) {
            let isVideo = pick.supportedContentTypes.contains { $0.conforms(to: .movie) }
            do {
                if isVideo {
                    guard let movie = try await pick.loadTransferable(type: PickedMovie.self) else { continue }
                    let movieAsset = AVURLAsset(url: movie.url)
                    let duration = (try? await movieAsset.load(.duration))?.seconds
                    let key = pick.itemIdentifier ?? UUID().uuidString
                    added.append(DeckItem(id: "picked-\(key)", kind: .video, assetID: nil, photoData: nil, videoFile: movie.url, duration: duration, origin: .picked))
                } else {
                    guard let data = try await pick.loadTransferable(type: Data.self) else { continue }
                    // Keep the deck small in memory: store the same compressed form we would upload.
                    let compressed = (try? MediaProcessor.compressPhoto(data)) ?? data
                    guard compressed.count <= MediaConstraints.photoMaxBytes else { continue }
                    let key = pick.itemIdentifier ?? UUID().uuidString
                    added.append(DeckItem(id: "picked-\(key)", kind: .photo, assetID: nil, photoData: compressed, videoFile: nil, duration: nil, origin: .picked))
                }
            } catch {
                continue
            }
        }
        guard !added.isEmpty else {
            note = "Couldn't read those items. Try different ones."
            return
        }
        state.add(added)
        notify()
    }

    func toggleHidden(_ id: String) {
        let hide = !state.isHidden(id)
        state.setHidden(id, hide)
        if let assetID = state.item(id)?.assetID {
            if hide { hiddenAssets.insert(assetID) } else { hiddenAssets.remove(assetID) }
            defaults.set(Array(hiddenAssets), forKey: Self.hiddenDefaultsKey)
        }
        notify()
    }

    // MARK: - Processing

    /// One random unused, unhidden item that fits the mode.
    func randomCandidate(mode: MediaMode) -> DeckItem? {
        state.candidates(mode).randomElement()
    }

    /// Compresses a photo or cuts a clip. Never uploads; the caller holds the bytes.
    func prepare(_ item: DeckItem) async throws -> PreparedItem {
        switch item.kind {
        case .photo:
            let data: Data
            if let assetID = item.assetID, let asset = MediaLibrary.asset(id: assetID) {
                data = try await MediaProcessor.photo(from: asset)
            } else if let photoData = item.photoData {
                data = try MediaProcessor.compressPhoto(photoData)
            } else {
                throw MediaError.unreadable
            }
            try MediaConstraints.validate(bytes: data.count, kind: .photo)
            return PreparedItem(itemID: item.id, kind: .photo, data: data)

        case .video:
            let asset: AVAsset
            if let assetID = item.assetID, let photoAsset = MediaLibrary.asset(id: assetID) {
                asset = try await MediaProcessor.avAsset(from: photoAsset)
            } else if let file = item.videoFile {
                asset = AVURLAsset(url: file)
            } else {
                throw MediaError.unreadable
            }
            let duration = try await asset.load(.duration).seconds
            guard duration >= MediaConstraints.clipMinSeconds else { throw MediaError.tooShort }
            let url = try await MediaProcessor.clip(from: asset)
            defer { try? FileManager.default.removeItem(at: url) }
            let data = try Data(contentsOf: url)
            try MediaConstraints.validate(bytes: data.count, kind: .video)
            return PreparedItem(itemID: item.id, kind: .video, data: data)
        }
    }

    // MARK: - Thumbnails and previews

    func thumbnail(for item: DeckItem, size: CGSize) async -> UIImage? {
        let key = "\(item.id)-\(Int(size.width))x\(Int(size.height))" as NSString
        if let cached = thumbnails.object(forKey: key) { return cached }

        var image: UIImage?
        if let data = item.photoData {
            image = UIImage(data: data)
        } else if let assetID = item.assetID, let asset = MediaLibrary.asset(id: assetID) {
            image = await requestImage(asset, size: size)
        }
        if let image { thumbnails.setObject(image, forKey: key) }
        return image
    }

    func previewImage(for item: DeckItem) async -> UIImage? {
        await thumbnail(for: item, size: CGSize(width: 900, height: 900))
    }

    /// A looping player's item for a local preview (library video or picked file).
    func playerItem(for item: DeckItem) async -> AVPlayerItem? {
        if let file = item.videoFile { return AVPlayerItem(url: file) }
        guard let assetID = item.assetID, let asset = MediaLibrary.asset(id: assetID) else { return nil }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        return await withCheckedContinuation { continuation in
            let box = ContinuationBox(continuation)
            PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { playerItem, _ in
                box.resume(playerItem)
            }
        }
    }

    private func requestImage(_ asset: PHAsset, size: CGSize) async -> UIImage? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        let scale: CGFloat = 2
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        return await withCheckedContinuation { continuation in
            let box = ContinuationBox(continuation)
            manager.requestImage(for: asset, targetSize: target, contentMode: .aspectFill, options: options) { image, _ in
                box.resume(image)
            }
        }
    }

    private func notify() {
        onChange?()
    }
}

/// Resumes a continuation exactly once even if PhotoKit calls back more than once.
private final class ContinuationBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    func resume(_ value: T) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
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
