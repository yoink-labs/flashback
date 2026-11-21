import XCTest
@testable import Flashback

/// Pure deck logic: what is counted, what is hidden, and what may be picked.
final class DeckStateTests: XCTestCase {
    private func library(_ id: String, _ kind: MediaKind) -> DeckItem {
        DeckItem(
            id: id,
            kind: kind,
            assetID: id,
            photoData: nil,
            videoFile: nil,
            duration: kind == .video ? 6 : nil,
            origin: .library(id)
        )
    }

    private func picked(_ id: String, _ kind: MediaKind) -> DeckItem {
        DeckItem(
            id: id,
            kind: kind,
            assetID: nil,
            photoData: kind == .photo ? Data([1]) : nil,
            videoFile: kind == .video ? URL(fileURLWithPath: "/tmp/\(id).mp4") : nil,
            duration: kind == .video ? 6 : nil,
            origin: .picked
        )
    }

    func testCountsFollowModeAndHiddenItems() {
        var deck = DeckState()
        deck.add([library("p1", .photo), library("p2", .photo), library("v1", .video), library("v2", .video)])

        XCTAssertEqual(deck.counts(.both), DeckCount(photos: 2, videos: 2))
        XCTAssertEqual(deck.counts(.photos), DeckCount(photos: 2, videos: 0))
        XCTAssertEqual(deck.counts(.videos), DeckCount(photos: 0, videos: 2))

        deck.setHidden("p1", true)
        XCTAssertTrue(deck.isHidden("p1"))
        XCTAssertEqual(deck.counts(.both), DeckCount(photos: 1, videos: 2))
        XCTAssertEqual(deck.candidates(.both).map(\.id).sorted(), ["p2", "v1", "v2"])
        XCTAssertEqual(deck.candidates(.videos).map(\.id).sorted(), ["v1", "v2"])

        deck.setHidden("p1", false)
        XCTAssertEqual(deck.counts(.both), DeckCount(photos: 2, videos: 2))
    }

    func testUsedItemsAreSkippedUntilTheDeckRunsOut() {
        var deck = DeckState()
        deck.add([library("p1", .photo), library("p2", .photo)])
        deck.markUsed("p1")
        XCTAssertEqual(deck.candidates(.photos).map(\.id), ["p2"])

        deck.markUsed("p2")
        // Everything shown this session: the deck starts over rather than going dry.
        XCTAssertEqual(deck.candidates(.photos).map(\.id).sorted(), ["p1", "p2"])

        XCTAssertTrue(deck.candidates(.videos).isEmpty)
        XCTAssertTrue(deck.counts(.videos).total == 0)
    }

    func testModeFitForDeckCounts() {
        XCTAssertTrue(DeckCount(photos: 1).fits(.photos))
        XCTAssertFalse(DeckCount(photos: 1).fits(.videos))
        XCTAssertFalse(DeckCount(videos: 0).fits(.videos))
        XCTAssertTrue(DeckCount(videos: 1).fits(.videos))
        XCTAssertTrue(DeckCount(photos: 2, videos: 3).fits(.both))
        XCTAssertFalse(DeckCount().fits(.both))
    }

    func testShuffleKeepsHandPickedItemsAndDropsDuplicates() {
        var deck = DeckState()
        deck.add([picked("picked-1", .photo), library("p1", .photo)])
        deck.replaceLibrary([library("p1", .photo), library("p3", .photo)])
        XCTAssertEqual(deck.items.map(\.id), ["picked-1", "p1", "p3"])

        deck.add([library("p1", .photo), library("p4", .video)])
        XCTAssertEqual(deck.items.map(\.id), ["picked-1", "p1", "p3", "p4"])
    }

    func testHiddenIdentifiersStayHiddenAcrossShuffles() {
        var deck = DeckState()
        deck.add([library("p1", .photo), library("p2", .photo)])
        deck.setHidden("p1", true)
        deck.replaceLibrary([library("p1", .photo), library("p3", .photo)])
        // A remembered hidden id is still excluded even when it is shuffled back in.
        XCTAssertTrue(deck.isHidden("p1"))
        XCTAssertEqual(deck.candidates(.photos).map(\.id), ["p3"])
    }

    func testDeckItemDurationLabels() {
        XCTAssertEqual(library("v1", .video).durationLabel, "0:06")
        XCTAssertNil(library("p1", .photo).durationLabel)
    }
}
