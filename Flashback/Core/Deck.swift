import AVFoundation
import Photos
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A processed item held in memory, ready to upload the moment it is asked for.
struct PreparedItem: Equatable {
    var itemID: String
    var kind: MediaKind
    var data: Data
}

/// Owns the player's bunches, their thumbnails, and on-demand processing.
/// Everything lives here (not in views) so folding, rotating, or leaving the
/// lobby never loses the bunch, the swaps, the open preview, or which step is
/// showing. The rules live in `DeckState`; this class only feeds it items from
/// PhotoKit or the system picker.
@MainActor final class DeckStore: ObservableObject {
    /// Same key as the old hidden list: swapped-out library ids, never dealt again.
    static let hiddenDefaultsKey = "flashback.hiddenAssets"

    @Published private(set) var state: DeckState
    /// Kinds currently being dealt.
    @Published private(set) var dealing: Set<MediaKind> = []
    /// Tiles whose replacement is loading.
    @Published private(set) var swapping: Set<String> = []
    /// One short line per bunch ("Pick more photos to swap").
    @Published private(set) var notes: [MediaKind: String] = [:]
    /// Which bunch the lobby shows in Mix ("Photos" or "Videos" step).
    @Published var step: MediaKind = .photo
    /// The tile held open full screen (kept here so a fold doesn't close it).
    @Published var previewing: DeckItem?
    @Published private(set) var mode: MediaMode = .both

    /// Called after the bunches change so `RoomStore` can report the new counts.
    var onChange: (@MainActor () -> Void)?

    private let defaults: UserDefaults
    /// Swapped-out library identifiers, remembered across games on this device.
    private var hiddenAssets: Set<String>
    private let manager = PHCachingImageManager()
    private let thumbnails = NSCache<NSString, UIImage>()
    /// System-picker items not loaded yet, keyed by pool id.
    private var pickerItems: [String: PhotosPickerItem] = [:]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let hidden = Set(defaults.stringArray(forKey: Self.hiddenDefaultsKey) ?? [])
        self.hiddenAssets = hidden
        self.state = DeckState(swappedOut: hidden)
    }

    var items: [DeckItem] { state.items }
    var used: Set<String> { state.used }
    /// The steps this room actually uses. Even Split can size a kind at 0
    /// (e.g. two rounds over four players in Mix), and an empty step would only
    /// confuse the review.
    var kinds: [MediaKind] { DeckState.kinds(mode).filter { state.requiredSize($0) > 0 } }

    func bunch(_ kind: MediaKind) -> Bunch { state[kind] }
    func counts(mode: MediaMode) -> DeckCount { state.counts(mode) }
    func item(_ id: String) -> DeckItem? { state.item(id) }
    func isDealing(_ kind: MediaKind) -> Bool { dealing.contains(kind) }
    func note(_ kind: MediaKind) -> String? { notes[kind] }

    /// The room's required bunch size for a kind (Milestone 4 §2).
    func requiredSize(_ kind: MediaKind) -> Int { state.requiredSize(kind) }
    /// The bunch is complete for the room's mode and current bunch sizes.
    func fits(_ mode: MediaMode) -> Bool { state.fits(mode) }
    /// How many items one pick may add: the usual 60, or enough for a large
    /// Even Split bunch.
    func maxPickCount(_ kind: MediaKind) -> Int { max(DeckState.poolLimit, state.requiredSize(kind)) }

    /// A deal or swap is still landing: Ready / Start wait, so the counts the
    /// server sees are never from a half-applied bunch.
    var isBusy: Bool { !dealing.isEmpty || !swapping.isEmpty }

    /// The step the lobby should show: the chosen one when the room uses it.
    var currentStep: MediaKind { kinds.contains(step) ? step : (kinds.first ?? .photo) }

    private var topUpWork: Task<Void, Never>?

    /// Room settings arrived or changed: media mode, swaps (clamped), and the
    /// server's bunch sizes. A bunch that grew is topped up from wherever it was
    /// dealt; one that shrank already dropped its extra tiles from the end.
    func configure(_ settings: RoomSettings, bunch: BunchRequirement) {
        let oldMode = mode
        mode = settings.mediaMode
        var next = state
        next.configure(swaps: settings.swaps)
        let requirementChanged = next.setRequirement(bunch)
        if next != state { state = next }
        if !kinds.contains(step) { step = kinds.first ?? .photo }
        if oldMode != mode { notes = [:] }
        if requirementChanged {
            notify()
            scheduleTopUp()
        } else if oldMode != mode {
            notify()
        }
    }

    /// Grows every dealt bunch to the room's required size. Empty bunches are
    /// left to the player's "Deal my photos" button, so joining a room never
    /// triggers a surprise library permission prompt.
    func topUpToRequirement() async {
        for kind in kinds {
            let missing = state.requiredSize(kind) - state[kind].items.count
            guard missing > 0, !state[kind].items.isEmpty, !dealing.contains(kind) else { continue }
            dealing.insert(kind)
            notes[kind] = nil
            let items = await draw(kind, count: missing, from: state[kind].source, replacing: true)
            state.topUp(kind, items: items)
            dealing.remove(kind)
            notify()
        }
    }

    private func scheduleTopUp() {
        topUpWork?.cancel()
        let needsMore = kinds.contains {
            state.requiredSize($0) > state[$0].items.count && !state[$0].items.isEmpty
        }
        guard needsMore else { return }
        topUpWork = Task { [weak self] in await self?.topUpToRequirement() }
    }

    /// Shown (or unusable) this session. Not a bunch change: counts stay the same.
    func markUsed(_ id: String) {
        state.markUsed(id)
    }

    /// A new room starts the shown-this-session bookkeeping and the swaps over.
    func resetForNewRoom() {
        state.used.removeAll()
        state.swapLimit = nil
        notify()
    }

    // MARK: - Dealing and swapping

    /// "Deal my photos" / "New bunch": a fresh random bunch of `kind` from the
    /// library (or from the pool), with swaps reset.
    func deal(_ kind: MediaKind) async {
        guard !dealing.contains(kind) else { return }
        dealing.insert(kind)
        notes[kind] = nil
        defer { dealing.remove(kind) }

        let size = requiredSize(kind)
        if state[kind].source == .picked, state.poolCount(kind) > 0 {
            state.deal(kind, items: await draw(kind, count: size, from: .picked, replacing: false), source: .picked)
        } else {
            guard await libraryAccess(kind) else { return }
            let fresh = await draw(kind, count: size, from: .library, replacing: false)
            guard !fresh.isEmpty else {
                notes[kind] = MediaError.nothingFound(kind == .photo ? .photos : .videos).localizedDescription
                return
            }
            state.dealFromLibrary(kind, items: fresh)
        }
        notify()
    }

    /// Tap a tile: swap it for another random item, using one swap.
    @discardableResult
    func swap(_ id: String) async -> SwapResult {
        guard let kind = state.kind(of: id) else { return .notFound }
        guard state[kind].swapsLeft > 0 else { return .noSwapsLeft }
        guard !swapping.contains(id) else { return .notFound }
        swapping.insert(id)
        defer { swapping.remove(id) }

        let swappedOut = state.item(id)
        var result = SwapResult.nothingToDraw
        // Two tiles swapping at once can draw the same replacement while the
        // pool loads; the one that loses the race draws again.
        for _ in 0..<2 {
            let replacement = await draw(kind, count: 1, from: state[kind].source, replacing: true).first
            result = state.swap(id, with: replacement)
            guard result == .nothingToDraw, replacement != nil else { break }
        }
        switch result {
        case .swapped:
            notes[kind] = nil
            if let assetID = swappedOut?.assetID {
                hiddenAssets.insert(assetID)
                defaults.set(Array(hiddenAssets), forKey: Self.hiddenDefaultsKey)
            }
            notify()
        case .nothingToDraw:
            notes[kind] = kind == .photo ? "Pick more photos to swap" : "Pick more videos to swap"
        case .noSwapsLeft, .notFound:
            break
        }
        return result
    }

    /// "Pick photos" / "Pick videos": the picks join the pool (by their own
    /// kind), the bunch switches to drawing from it, and it is dealt (or its
    /// empty slots topped up) right away. Nothing is loaded until it is dealt.
    func addPicked(_ picked: [PhotosPickerItem], kind: MediaKind) async {
        guard !picked.isEmpty else { return }
        var poolItems: [DeckItem] = []
        for pick in picked.prefix(DeckState.poolLimit) {
            let isVideo = pick.supportedContentTypes.contains { $0.conforms(to: .movie) }
            let id = "picked-\(pick.itemIdentifier ?? UUID().uuidString)"
            // Picking the same item again (ids come from the shared library) is a no-op.
            if !state.pool.contains(where: { $0.id == id }) { pickerItems[id] = pick }
            poolItems.append(.pickedPlaceholder(id: id, kind: isVideo ? .video : .photo))
        }
        state.addToPool(poolItems)
        guard !dealing.contains(kind) else { return }

        dealing.insert(kind)
        notes[kind] = nil
        defer { dealing.remove(kind) }
        let bunch = state[kind]
        if bunch.source == .picked, !bunch.items.isEmpty {
            let room = requiredSize(kind) - bunch.items.count
            state.topUp(kind, items: await draw(kind, count: room, from: .picked, replacing: true))
        } else {
            state.deal(kind, items: await draw(kind, count: requiredSize(kind), from: .picked, replacing: false), source: .picked)
        }
        if state[kind].items.isEmpty { notes[kind] = "Couldn't read those items. Try different ones." }
        notify()
    }

    /// Up to `count` new items of `kind`, best first. `replacing` leaves out
    /// what is in the bunch now (swaps and top-ups).
    private func draw(_ kind: MediaKind, count: Int, from source: Bunch.Source, replacing: Bool) async -> [DeckItem] {
        guard count > 0 else { return [] }
        switch source {
        case .picked:
            // A few spares, since a picked item can fail to load.
            let candidates = state.drawFromPool(kind, count: count + 4, excludingBunch: replacing)
            return await materialize(candidates, want: count)
        case .library:
            // Never-dealt first; when the library runs dry, allow ones dealt
            // before (never swapped-out ones).
            var assets = MediaLibrary.randomAssets(kind: kind, count: count, excluding: state.libraryExclusions(kind, strict: true, excludingBunch: replacing))
            if assets.count < count {
                let have = Set(assets.map(\.localIdentifier))
                let relaxed = state.libraryExclusions(kind, strict: false, excludingBunch: replacing).union(have)
                assets += MediaLibrary.randomAssets(kind: kind, count: count - assets.count, excluding: relaxed)
            }
            return assets.map(DeckItem.library)
        }
    }

    private func libraryAccess(_ kind: MediaKind) async -> Bool {
        let access = MediaLibrary.currentAccess == .denied ? await MediaLibrary.requestAccess() : MediaLibrary.currentAccess
        guard access == .denied else { return true }
        notes[kind] = kind == .photo
            ? "Flashback can't see your photos. Use Pick photos instead."
            : "Flashback can't see your videos. Use Pick videos instead."
        return false
    }

    /// Loads picked pool items (compressed photo bytes or a temp movie file),
    /// skipping any that fail or are too short to play, until `want` are ready.
    /// Loaded items replace their placeholders in the pool, so each loads once.
    private func materialize(_ candidates: [DeckItem], want: Int) async -> [DeckItem] {
        var out: [DeckItem] = []
        for candidate in candidates where out.count < want {
            if candidate.isLoaded {
                out.append(candidate)
                continue
            }
            guard let pick = pickerItems[candidate.id], let item = await load(candidate, from: pick) else { continue }
            pickerItems[candidate.id] = nil
            state.updatePool(item)
            if item.isPlayable { out.append(item) }
        }
        return out
    }

    private func load(_ candidate: DeckItem, from pick: PhotosPickerItem) async -> DeckItem? {
        var item = candidate
        do {
            if candidate.kind == .video {
                guard let movie = try await pick.loadTransferable(type: PickedMovie.self) else { return nil }
                item.videoFile = movie.url
                item.duration = (try? await AVURLAsset(url: movie.url).load(.duration))?.seconds
            } else {
                guard let data = try await pick.loadTransferable(type: Data.self) else { return nil }
                // Keep memory small: store the same compressed form we would upload.
                let compressed = (try? MediaProcessor.compressPhoto(data)) ?? data
                guard compressed.count <= MediaConstraints.photoMaxBytes else { return nil }
                item.photoData = compressed
            }
            return item
        } catch {
            return nil
        }
    }

    #if DEBUG
    /// Screenshot fixtures: fills bunches without PhotoKit.
    func debugFill(photos: [DeckItem], videos: [DeckItem], swapsLeft: Int? = nil) {
        state.addToPool(photos + videos)
        if !photos.isEmpty { state.deal(.photo, items: photos, source: .picked) }
        if !videos.isEmpty { state.deal(.video, items: videos, source: .picked) }
        if let swapsLeft { state.photos.swapsLeft = swapsLeft; state.videos.swapsLeft = swapsLeft }
        notify()
    }
    #endif

    // MARK: - Processing

    /// One random unused bunch item that fits the mode (and kind, if given).
    func randomCandidate(mode: MediaMode, kind: MediaKind? = nil) -> DeckItem? {
        state.candidates(mode, kind: kind).randomElement()
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
            image = UIImage(data: data)?.preparingThumbnail(of: CGSize(width: size.width * 2, height: size.height * 2)) ?? UIImage(data: data)
        } else if let assetID = item.assetID, let asset = MediaLibrary.asset(id: assetID) {
            image = await requestImage(asset, size: size)
        } else if let file = item.videoFile {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: size.width * 2, height: size.height * 2)
            if let cg = try? await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)).image {
                image = UIImage(cgImage: cg)
            }
        }
        if let image { thumbnails.setObject(image, forKey: key) }
        return image
    }

    func previewImage(for item: DeckItem) async -> UIImage? {
        if let data = item.photoData { return UIImage(data: data) }
        return await thumbnail(for: item, size: CGSize(width: 900, height: 900))
    }

    /// A player item for a local preview (library video or picked file).
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
