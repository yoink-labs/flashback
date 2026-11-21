import XCTest
@testable import Flashback

/// Pure bunch logic: equal bunches (12 photos, 6 videos), swaps, New bunch,
/// clamping, the picked pool, and never re-drawing swapped-out items.
final class DeckStateTests: XCTestCase {
    private func library(_ id: String, _ kind: MediaKind) -> DeckItem {
        DeckItem(id: id, kind: kind, assetID: id, photoData: nil, videoFile: nil, duration: kind == .video ? 6 : nil, origin: .library(id))
    }

    private func picked(_ id: String, _ kind: MediaKind) -> DeckItem {
        DeckItem(id: id, kind: kind, assetID: nil, photoData: kind == .photo ? Data([1]) : nil, videoFile: kind == .video ? URL(fileURLWithPath: "/tmp/\(id).mp4") : nil, duration: kind == .video ? 6 : nil, origin: .picked)
    }

    private func photos(_ count: Int, prefix: String = "p") -> [DeckItem] {
        (0..<count).map { library("\(prefix)\($0)", .photo) }
    }

    private func videos(_ count: Int, prefix: String = "v") -> [DeckItem] {
        (0..<count).map { library("\(prefix)\($0)", .video) }
    }

    /// Deterministic generator for pool draws.
    private struct SeededGenerator: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return state
        }
    }

    func testBunchSizesAndCountsFollowTheMode() {
        XCTAssertEqual(DeckState.photoSize, 12)
        XCTAssertEqual(DeckState.videoSize, 6)
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(20), source: .library)
        deck.deal(.video, items: videos(10), source: .library)

        XCTAssertEqual(deck.photos.items.count, 12)
        XCTAssertEqual(deck.videos.items.count, 6)
        XCTAssertEqual(deck.counts(.both), DeckCount(photos: 12, videos: 6))
        XCTAssertEqual(deck.counts(.photos), DeckCount(photos: 12, videos: 0))
        XCTAssertEqual(deck.counts(.videos), DeckCount(photos: 0, videos: 6))
        XCTAssertTrue(deck.counts(.both).fits(.both))
        XCTAssertEqual(DeckState.kinds(.both), [.photo, .video])
        XCTAssertEqual(DeckState.kinds(.videos), [.video])
        // A deal never mixes kinds.
        deck.deal(.photo, items: videos(3, prefix: "x"), source: .library)
        XCTAssertTrue(deck.photos.items.isEmpty)
    }

    func testEqualBunchRuleAndMissingCounts() {
        XCTAssertTrue(DeckCount(photos: 12).fits(.photos))
        XCTAssertFalse(DeckCount(photos: 11).fits(.photos))
        XCTAssertFalse(DeckCount(photos: 12).fits(.videos))
        XCTAssertTrue(DeckCount(videos: 6).fits(.videos))
        XCTAssertFalse(DeckCount(photos: 12, videos: 4).fits(.both))
        XCTAssertTrue(DeckCount(photos: 12, videos: 6).fits(.both))
        XCTAssertEqual(DeckCount(photos: 12, videos: 4).missing(.both), DeckCount(photos: 0, videos: 2))
        XCTAssertFalse(DeckCount().fits(.both))
    }

    func testSwapConsumesOneSwapAndReplacesInPlace() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(12), source: .library)
        let result = deck.swap("p4", with: library("new", .photo))
        XCTAssertEqual(result, .swapped)
        XCTAssertEqual(deck.photos.items[4].id, "new")
        XCTAssertEqual(deck.photos.items.count, 12)
        XCTAssertEqual(deck.photos.swapsLeft, 2)
        XCTAssertTrue(deck.swappedOut.contains("p4"))
        XCTAssertTrue(deck.seen.contains("new"))
        // Videos have their own swaps.
        deck.deal(.video, items: videos(6), source: .library)
        XCTAssertEqual(deck.videos.swapsLeft, 3)
    }

    func testSwapsExhausted() {
        var deck = DeckState()
        deck.configure(swaps: 1)
        deck.deal(.photo, items: photos(12), source: .library)
        XCTAssertEqual(deck.swap("p0", with: library("a", .photo)), .swapped)
        XCTAssertEqual(deck.swap("p1", with: library("b", .photo)), .noSwapsLeft)
        XCTAssertEqual(deck.photos.items[1].id, "p1")
        XCTAssertEqual(deck.swap("nope", with: library("c", .photo)), .notFound)
        // Nothing to draw does not use a swap.
        var other = DeckState()
        other.configure(swaps: 2)
        other.deal(.photo, items: photos(12), source: .library)
        XCTAssertEqual(other.swap("p0", with: nil), .nothingToDraw)
        XCTAssertEqual(other.swap("p0", with: library("p1", .photo)), .nothingToDraw) // already in the bunch
        XCTAssertEqual(other.photos.swapsLeft, 2)
    }

    func testNewBunchResetsSwaps() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(12), source: .library)
        deck.swap("p0", with: library("a", .photo))
        deck.swap("p1", with: library("b", .photo))
        XCTAssertEqual(deck.photos.swapsLeft, 1)
        deck.deal(.photo, items: photos(12, prefix: "q"), source: .library)
        XCTAssertEqual(deck.photos.swapsLeft, 3)
        XCTAssertEqual(deck.photos.items.first?.id, "q0")
    }

    func testClampWhenSettingsChange() {
        var deck = DeckState()
        deck.configure(swaps: 5)
        deck.deal(.photo, items: photos(12), source: .library)
        XCTAssertEqual(deck.photos.swapsLeft, 5)
        deck.swap("p0", with: library("a", .photo))
        XCTAssertEqual(deck.photos.swapsLeft, 4)
        deck.configure(swaps: 1)
        XCTAssertEqual(deck.photos.swapsLeft, 1)
        // Raising the limit never adds swaps; New bunch does.
        deck.configure(swaps: 10)
        XCTAssertEqual(deck.photos.swapsLeft, 1)
        deck.deal(.photo, items: photos(12, prefix: "z"), source: .library)
        XCTAssertEqual(deck.photos.swapsLeft, 10)
        // A new room (limit reset) gives the full amount again.
        deck.swapLimit = nil
        deck.configure(swaps: 3)
        XCTAssertEqual(deck.photos.swapsLeft, 3)
    }

    func testPoolDrawsNeverRedrawSwappedOutItems() {
        var deck = DeckState()
        deck.configure(swaps: 10)
        deck.addToPool((0..<16).map { picked("k\($0)", .photo) })
        var rng = SeededGenerator(state: 7)
        deck.deal(.photo, items: deck.drawFromPool(.photo, count: 12, excludingBunch: false, using: &rng), source: .picked)
        let first = Set(deck.photos.items.map(\.id))
        XCTAssertEqual(first.count, 12)

        // Swap out one: the replacement is one of the 4 never-seen items.
        let vetoed = deck.photos.items[0].id
        let replacement = deck.drawFromPool(.photo, count: 1, excludingBunch: true, using: &rng).first
        XCTAssertNotNil(replacement)
        XCTAssertFalse(first.contains(replacement!.id))
        XCTAssertEqual(deck.swap(vetoed, with: replacement), .swapped)

        // A New bunch draws the remaining unseen ones first, then seen ones,
        // and leaves the vetoed item out while anything else is left.
        for _ in 0..<5 {
            let draw = deck.drawFromPool(.photo, count: 12, excludingBunch: false, using: &rng)
            XCTAssertEqual(draw.count, 12)
            XCTAssertFalse(draw.contains { $0.id == vetoed })
            deck.deal(.photo, items: draw, source: .picked)
        }
    }

    func testPoolExhaustion() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.addToPool((0..<4).map { picked("v\($0)", .video) })
        var rng = SeededGenerator(state: 3)
        deck.deal(.video, items: deck.drawFromPool(.video, count: 6, excludingBunch: false, using: &rng), source: .picked)
        // Only 4 of 6: the bunch is short and the player can't ready.
        XCTAssertEqual(deck.videos.items.count, 4)
        XCTAssertEqual(deck.shortfall(.video), 4)
        XCTAssertFalse(deck.counts(.videos).fits(.videos))
        // Every pool item is in the bunch: a swap has nothing to draw.
        XCTAssertTrue(deck.drawFromPool(.video, count: 1, excludingBunch: true, using: &rng).isEmpty)
        XCTAssertEqual(deck.swap("v0", with: nil), .nothingToDraw)
        XCTAssertEqual(deck.videos.swapsLeft, 3)
        // Topping up fills only the empty slots.
        deck.addToPool([picked("v4", .video), picked("v5", .video), picked("v6", .video)])
        deck.topUp(.video, items: deck.drawFromPool(.video, count: 2, excludingBunch: true, using: &rng))
        XCTAssertEqual(deck.videos.items.count, 6)
        XCTAssertNil(deck.shortfall(.video))
        XCTAssertEqual(deck.videos.items.prefix(4).map(\.id).sorted(), ["v0", "v1", "v2", "v3"])
    }

    func testPoolIsCappedPerKindAndDeduplicated() {
        var deck = DeckState()
        XCTAssertEqual(deck.addToPool((0..<70).map { picked("a\($0)", .photo) }), 60)
        XCTAssertEqual(deck.addToPool([picked("a1", .photo), picked("b1", .video)]), 1)
        XCTAssertEqual(deck.poolCount(.photo), 60)
        XCTAssertEqual(deck.poolCount(.video), 1)
    }

    func testLibraryExclusionsKeepVetoedIdsOut() {
        var deck = DeckState(swappedOut: ["old"])
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(12), source: .library)
        deck.swap("p0", with: library("n", .photo))
        let strict = deck.libraryExclusions(.photo, strict: true, excludingBunch: true)
        XCTAssertTrue(strict.isSuperset(of: ["old", "p0", "n", "p5"]))
        let relaxed = deck.libraryExclusions(.photo, strict: false, excludingBunch: false)
        XCTAssertEqual(relaxed, ["old", "p0"])
    }

    func testCandidatesFollowKindAndUsedItemsRecycle() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(12), source: .library)
        deck.deal(.video, items: videos(6), source: .library)
        XCTAssertTrue(deck.candidates(.both, kind: .video).allSatisfy { $0.kind == .video })
        XCTAssertTrue(deck.candidates(.photos).allSatisfy { $0.kind == .photo })
        for item in deck.videos.items { deck.markUsed(item.id) }
        // Everything shown: start over rather than going dry.
        XCTAssertEqual(deck.candidates(.both, kind: .video).count, 6)
        deck.markUsed("p0")
        XCTAssertFalse(deck.candidates(.photos).contains { $0.id == "p0" })
    }

    func testShortLibraryBecomesThePoolSoPicksTopItUp() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        // A library (or limited selection) with only 5 photos.
        deck.dealFromLibrary(.photo, items: photos(5))
        XCTAssertEqual(deck.photos.source, .picked)
        XCTAssertEqual(deck.shortfall(.photo), 5)
        XCTAssertEqual(deck.poolCount(.photo), 5)
        // Picks join the same pool and fill the empty slots; the library items stay.
        deck.addToPool((0..<9).map { picked("k\($0)", .photo) })
        var rng = SeededGenerator(state: 11)
        deck.topUp(.photo, items: deck.drawFromPool(.photo, count: 7, excludingBunch: true, using: &rng))
        XCTAssertEqual(deck.photos.items.count, 12)
        XCTAssertEqual(Array(deck.photos.items.prefix(5).map(\.id)), ["p0", "p1", "p2", "p3", "p4"])
        // Swaps now draw from the pool remainder (library items and picks alike).
        let replacement = deck.drawFromPool(.photo, count: 1, excludingBunch: true, using: &rng).first
        XCTAssertNotNil(replacement)
        XCTAssertEqual(deck.swap("p0", with: replacement), .swapped)
    }

    func testFullLibraryDealStaysOnTheLibrary() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.dealFromLibrary(.video, items: videos(6) + photos(3))
        XCTAssertEqual(deck.videos.source, .library)
        XCTAssertEqual(deck.videos.items.count, 6)
        XCTAssertTrue(deck.pool.isEmpty)
    }

    func testClipsUnderASecondNeverTakeASlot() {
        var short = picked("s", .video)
        short.duration = 0.6
        XCTAssertFalse(short.isPlayable)
        var unknown = picked("u", .video)
        unknown.duration = nil
        XCTAssertTrue(unknown.isPlayable)
        XCTAssertTrue(picked("x", .photo).isPlayable)
        XCTAssertTrue(picked("v", .video).isPlayable)

        // Loading a placeholder replaces it in the pool; an unplayable clip leaves.
        var deck = DeckState()
        deck.addToPool([.pickedPlaceholder(id: "s", kind: .video), .pickedPlaceholder(id: "v", kind: .video)])
        XCTAssertFalse(deck.pool[0].isLoaded)
        deck.updatePool(short)
        deck.updatePool(picked("v", .video))
        XCTAssertEqual(deck.pool.map(\.id), ["v"])
        XCTAssertTrue(deck.pool[0].isLoaded)
    }

    func testRaceForTheSameReplacementLosesWithoutUsingASwap() {
        var deck = DeckState()
        deck.configure(swaps: 3)
        deck.deal(.photo, items: photos(12), source: .picked)
        let replacement = library("r", .photo)
        XCTAssertEqual(deck.swap("p0", with: replacement), .swapped)
        // A second, concurrent swap that drew the same item gets nothingToDraw
        // and keeps its swap, so DeckStore can draw again.
        XCTAssertEqual(deck.swap("p1", with: replacement), .nothingToDraw)
        XCTAssertEqual(deck.photos.swapsLeft, 2)
        XCTAssertEqual(deck.photos.items[1].id, "p1")
    }

    func testDeckItemDurationLabels() {
        XCTAssertEqual(library("v1", .video).durationLabel, "0:06")
        XCTAssertNil(library("p1", .photo).durationLabel)
    }
}

/// Pane splits at the fold and bunch grids sized to fill their box.
final class LayoutTests: XCTestCase {
    func testSplitsOnTheFoldWhenThereIsOne() {
        // Inner display safe area 867 wide, inactive fold (zero width) at 475.5.
        let split = PaneSplit.make(width: 867, fold: CGRect(x: 475.5, y: 0, width: 0, height: 669))
        XCTAssertEqual(split.leading, 459.5, accuracy: 0.01)
        XCTAssertEqual(split.gap, 32, accuracy: 0.01)
        XCTAssertEqual(split.leading + split.gap + split.trailing, 867, accuracy: 0.01)
        // The gap covers the fold-avoidance band (27 pt centred on the fold).
        XCTAssertLessThanOrEqual(split.leading, 475.5 - 13.5)
        XCTAssertGreaterThanOrEqual(split.leading + split.gap, 475.5 + 13.5)

        // An active, wider region: the gap is the region.
        let folded = PaneSplit.make(width: 867, fold: CGRect(x: 440, y: 0, width: 71, height: 669))
        XCTAssertEqual(folded.leading, 440, accuracy: 0.01)
        XCTAssertEqual(folded.gap, 71, accuracy: 0.01)
    }

    func testSplitsInHalfWithoutAFold() {
        let split = PaneSplit.make(width: 1000, fold: nil)
        XCTAssertEqual(split.leading, split.trailing, accuracy: 0.01)
        XCTAssertEqual(split.gap, PaneSplit.minGap)
        // A horizontal (tabletop) region is not a left/right fold.
        let tabletop = PaneSplit.make(width: 669, fold: CGRect(x: 0, y: 470, width: 669, height: 20))
        XCTAssertEqual(tabletop.leading, tabletop.trailing, accuracy: 0.01)
    }

    func testGridFillsATallPaneThreeByFour() {
        let metrics = BunchGridMetrics.fitting(width: 427, height: 565, count: 12)
        XCTAssertEqual(metrics.columns, 3)
        XCTAssertEqual(metrics.rows, 4)
        XCTAssertLessThanOrEqual(metrics.width, 427)
        XCTAssertLessThanOrEqual(metrics.height, 565)
        XCTAssertGreaterThan(metrics.tile, 130)
    }

    func testGridFillsAWidePaneFourByThree() {
        let metrics = BunchGridMetrics.fitting(width: 600, height: 380, count: 12)
        XCTAssertEqual(metrics.columns, 4)
        XCTAssertEqual(metrics.rows, 3)
        let videos = BunchGridMetrics.fitting(width: 600, height: 380, count: 6)
        XCTAssertEqual(videos.columns, 3)
        XCTAssertEqual(videos.rows, 2)
        let tallVideos = BunchGridMetrics.fitting(width: 400, height: 600, count: 6)
        XCTAssertEqual(tallVideos.columns, 2)
        XCTAssertEqual(tallVideos.rows, 3)
    }

    func testCompactGridFillsTheWidth() {
        // Outer display: 382 safe width, page padding 20 → 342 for the grid.
        let metrics = BunchGridMetrics.filling(width: 342, columns: 3, count: 12)
        XCTAssertEqual(metrics.rows, 4)
        XCTAssertEqual(metrics.tile, 111)
        XCTAssertEqual(metrics.gap, 4)
        XCTAssertLessThanOrEqual(metrics.width, 342)
        XCTAssertEqual(BunchGridMetrics.filling(width: 342, columns: 3, count: 6).rows, 2)
    }
}
