import Foundation
import Photos

// The deck is the local, visible set of photos and videos a player is willing
// to show. It never leaves the phone: the server only learns how many items fit
// the room's media mode, and only the one item picked for a round is uploaded.
//
// This file is the pure model (unit tested). `DeckStore` (Deck.swift) only
// orchestrates PhotoKit, the system picker, and thumbnails around it.

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

    /// A pool entry for a system-picker item that is loaded only when dealt.
    static func pickedPlaceholder(id: String, kind: MediaKind) -> DeckItem {
        DeckItem(id: id, kind: kind, assetID: nil, photoData: nil, videoFile: nil, duration: nil, origin: .picked)
    }

    /// Bytes, a file, or a library asset are on hand (nothing left to load).
    var isLoaded: Bool { photoData != nil || videoFile != nil || assetID != nil }

    /// A clip under a second can never be cut (`MediaError.tooShort`), so it
    /// must not take a bunch slot. Unknown durations get the benefit of the doubt.
    var isPlayable: Bool {
        guard kind == .video, let duration else { return true }
        return duration.isFinite && duration >= MediaConstraints.clipMinSeconds
    }

    var durationLabel: String? {
        guard kind == .video, let duration, duration.isFinite, duration > 0 else { return nil }
        let total = Int(duration.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// One bunch of a single kind: the items a player is willing to show, plus the
/// swaps they have left for it.
struct Bunch: Equatable {
    enum Source: Equatable {
        /// Random picks from the photo library (PhotoKit).
        case library
        /// Random picks from the pool (system-picker items, or a library too
        /// small to fill the bunch).
        case picked
    }

    var items: [DeckItem] = []
    var swapsLeft: Int = 0
    var source: Source = .library
}

enum SwapResult: Equatable {
    case swapped
    case noSwapsLeft
    /// The pool has nothing else to draw ("Pick more photos to swap").
    case nothingToDraw
    case notFound
}

/// Pure bunch logic (docs/MILESTONE3.md sections 1 and 7): a photo bunch of 12
/// and a video bunch of 6, each with its own swaps and New bunch. Swapped-out
/// items are never drawn again while the pool has anything else.
struct DeckState: Equatable {
    /// The Milestone 3 defaults, kept for fixtures and for old servers.
    static let photoSize = DeckCount.photoBunch
    static let videoSize = DeckCount.videoBunch
    /// The system picker allows this many per pick, and the pool per kind keeps
    /// at least this many (more when the room's bunch is larger).
    static let poolLimit = 60

    static func size(_ kind: MediaKind) -> Int { kind == .photo ? photoSize : videoSize }

    /// The bunches a room needs, in the order they are reviewed.
    static func kinds(_ mode: MediaMode) -> [MediaKind] {
        switch mode {
        case .photos: [.photo]
        case .videos: [.video]
        case .both: [.photo, .video]
        }
    }

    var photos = Bunch()
    var videos = Bunch()
    /// Items chosen with the system picker (both kinds). Bunches with a `.picked`
    /// source draw from here.
    var pool: [DeckItem] = []
    /// Shown in a round this session; picked again only when everything was shown.
    var used: Set<String> = []
    /// Vetoed with a swap. Library ids are also remembered on the device.
    var swappedOut: Set<String> = []
    /// Everything dealt this session, so swaps prefer something new.
    var seen: Set<String> = []
    /// `settings.swaps` as last applied; nil until the room's settings arrive.
    var swapLimit: Int?
    /// The room's bunch sizes (Milestone 4 §2). The server owns this: Even
    /// Split and the player count decide it, and clients keep bunches exactly
    /// this size.
    var requirement: BunchRequirement = .defaults

    init(swappedOut: Set<String> = []) {
        self.swappedOut = swappedOut
    }

    subscript(kind: MediaKind) -> Bunch {
        get { kind == .photo ? photos : videos }
        set { if kind == .photo { photos = newValue } else { videos = newValue } }
    }

    /// How many items this bunch must hold right now.
    func requiredSize(_ kind: MediaKind) -> Int { requirement.size(kind) }

    /// Applies the room's bunch sizes. Growing is the caller's job (it needs
    /// the library or the pool); shrinking drops tiles from the end, exactly as
    /// the contract says. Returns whether the requirement changed.
    @discardableResult
    mutating func setRequirement(_ requirement: BunchRequirement) -> Bool {
        let changed = self.requirement != requirement
        self.requirement = requirement
        for kind in [MediaKind.photo, .video] {
            let size = requiredSize(kind)
            if self[kind].items.count > size {
                self[kind].items = Array(self[kind].items.prefix(max(0, size)))
            }
        }
        return changed
    }

    /// Both bunches, photos first.
    var items: [DeckItem] { photos.items + videos.items }

    func item(_ id: String) -> DeckItem? { items.first { $0.id == id } }

    func kind(of id: String) -> MediaKind? {
        if photos.items.contains(where: { $0.id == id }) { return .photo }
        if videos.items.contains(where: { $0.id == id }) { return .video }
        return nil
    }

    /// Bunch items the room can use in this mode.
    func fitting(_ mode: MediaMode) -> [DeckItem] {
        Self.kinds(mode).flatMap { self[$0].items }
    }

    /// The counts sent to the server: bunch items fitting the mode, capped at
    /// the room's required size.
    func counts(_ mode: MediaMode) -> DeckCount {
        let kinds = Self.kinds(mode)
        return DeckCount(
            photos: kinds.contains(.photo) ? min(photos.items.count, requiredSize(.photo)) : 0,
            videos: kinds.contains(.video) ? min(videos.items.count, requiredSize(.video)) : 0
        )
    }

    /// Whether this player's bunches are complete for the room (server `deckFits`).
    func fits(_ mode: MediaMode) -> Bool {
        requirement.fits(counts(mode), mode: mode)
    }

    /// Unused bunch items that fit the mode (and `kind`, when the server asked
    /// for one). When every one has been shown this session, start over.
    func candidates(_ mode: MediaMode, kind: MediaKind? = nil) -> [DeckItem] {
        let fitting = fitting(mode).filter { kind == nil || $0.kind == kind }
        let unused = fitting.filter { !used.contains($0.id) }
        return unused.isEmpty ? fitting : unused
    }

    mutating func markUsed(_ id: String) {
        used.insert(id)
    }

    /// Applies `settings.swaps`. The first time (a new room) every bunch gets the
    /// full amount; after that remaining swaps are clamped to the new value.
    mutating func configure(swaps: Int) {
        let limit = max(0, swaps)
        for kind in [MediaKind.photo, .video] {
            self[kind].swapsLeft = swapLimit == nil ? limit : min(self[kind].swapsLeft, limit)
        }
        swapLimit = limit
    }

    /// New bunch: replaces every item of that kind and resets its swaps.
    mutating func deal(_ kind: MediaKind, items newItems: [DeckItem], source: Bunch.Source) {
        var bunch = Bunch()
        bunch.items = Array(newItems.filter { $0.kind == kind }.prefix(requiredSize(kind)))
        bunch.swapsLeft = swapLimit ?? RoomSettings.defaults.swaps
        bunch.source = source
        self[kind] = bunch
        seen.formUnion(bunch.items.map(\.id))
    }

    /// A deal from the photo library. A library that can't fill the bunch (a
    /// small or limited library) becomes the pool instead, so "Pick more" tops
    /// it up and swaps and New bunch draw from library items and picks alike.
    mutating func dealFromLibrary(_ kind: MediaKind, items newItems: [DeckItem]) {
        let fitting = newItems.filter { $0.kind == kind }
        guard fitting.count < requiredSize(kind) else {
            return deal(kind, items: fitting, source: .library)
        }
        addToPool(fitting)
        deal(kind, items: fitting, source: .picked)
    }

    /// Fills empty slots without touching the items or swaps already there.
    mutating func topUp(_ kind: MediaKind, items newItems: [DeckItem]) {
        var bunch = self[kind]
        let existing = Set(bunch.items.map(\.id))
        let room = max(0, requiredSize(kind) - bunch.items.count)
        let added = newItems.filter { $0.kind == kind && !existing.contains($0.id) }.prefix(room)
        bunch.items.append(contentsOf: added)
        self[kind] = bunch
        seen.formUnion(added.map(\.id))
    }

    /// Tap a tile: replace it in place with `replacement`, using one swap. The
    /// swapped-out item is remembered and not drawn again.
    @discardableResult
    mutating func swap(_ id: String, with replacement: DeckItem?) -> SwapResult {
        guard let kind = kind(of: id), let index = self[kind].items.firstIndex(where: { $0.id == id }) else { return .notFound }
        guard self[kind].swapsLeft > 0 else { return .noSwapsLeft }
        guard let replacement, replacement.kind == kind, !self[kind].items.contains(where: { $0.id == replacement.id }) else {
            return .nothingToDraw
        }
        self[kind].items[index] = replacement
        self[kind].swapsLeft -= 1
        swappedOut.insert(id)
        seen.insert(replacement.id)
        return .swapped
    }

    /// Adds items to the pool (deduplicated, at most the pool cap per kind).
    /// Returns how many were added.
    @discardableResult
    mutating func addToPool(_ newItems: [DeckItem]) -> Int {
        var added = 0
        var existing = Set(pool.map(\.id))
        var counts = [MediaKind.photo: poolCount(.photo), .video: poolCount(.video)]
        for item in newItems where !existing.contains(item.id) && counts[item.kind, default: 0] < poolCap(item.kind) {
            pool.append(item)
            existing.insert(item.id)
            counts[item.kind, default: 0] += 1
            added += 1
        }
        return added
    }

    /// The pool keeps at least the usual 60 per kind, and enough for a room
    /// whose Even Split bunch is larger than that.
    func poolCap(_ kind: MediaKind) -> Int { max(Self.poolLimit, requiredSize(kind)) }

    func poolCount(_ kind: MediaKind) -> Int { pool.filter { $0.kind == kind }.count }

    /// Replaces a pool entry once it is loaded (or drops one that can't be used),
    /// so the pool never offers an unplayable clip again.
    mutating func updatePool(_ item: DeckItem) {
        guard let index = pool.firstIndex(where: { $0.id == item.id }) else { return }
        if item.isPlayable { pool[index] = item } else { pool.remove(at: index) }
    }

    /// Random pool items of `kind`, best first: never seen, then seen but not
    /// swapped out, then (only when the pool has run dry) swapped-out ones.
    /// `excludingBunch` leaves out what is in the bunch now (swaps, top-ups).
    func drawFromPool<G: RandomNumberGenerator>(
        _ kind: MediaKind,
        count: Int,
        excludingBunch: Bool,
        using rng: inout G
    ) -> [DeckItem] {
        guard count > 0 else { return [] }
        let inBunch = excludingBunch ? Set(self[kind].items.map(\.id)) : []
        let available = pool.filter { $0.kind == kind && !inBunch.contains($0.id) }
        let fresh = available.filter { !seen.contains($0.id) && !swappedOut.contains($0.id) }.shuffled(using: &rng)
        let again = available.filter { seen.contains($0.id) && !swappedOut.contains($0.id) }.shuffled(using: &rng)
        let vetoed = available.filter { swappedOut.contains($0.id) }.shuffled(using: &rng)
        return Array((fresh + again + vetoed).prefix(count))
    }

    func drawFromPool(_ kind: MediaKind, count: Int, excludingBunch: Bool) -> [DeckItem] {
        var rng = SystemRandomNumberGenerator()
        return drawFromPool(kind, count: count, excludingBunch: excludingBunch, using: &rng)
    }

    /// Library ids to leave out of a PhotoKit draw. Strict: swapped out, already
    /// dealt this session, and the current bunch. Relaxed (the library ran dry):
    /// only swapped-out ids and the current bunch.
    func libraryExclusions(_ kind: MediaKind, strict: Bool, excludingBunch: Bool) -> Set<String> {
        var out = swappedOut
        if strict { out.formUnion(seen) }
        if excludingBunch { out.formUnion(self[kind].items.map(\.id)) }
        return out
    }

    /// "You have 4 of 6 videos": set when a bunch was dealt but the pool could
    /// not fill the room's required size.
    func shortfall(_ kind: MediaKind) -> Int? {
        let count = self[kind].items.count
        guard count > 0, count < requiredSize(kind) else { return nil }
        return count
    }
}
