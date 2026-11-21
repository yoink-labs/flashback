import AVFoundation
import XCTest
@testable import Flashback

/// A clip made by the web app (WebCodecs + mp4-muxer) must play in the iOS
/// reveal, through the one shared player (docs/MILESTONE4.md §8).
@MainActor final class PlaybackTests: XCTestCase {
    func testPlaysBrowserMadeClipOnTheSharedPlayer() async throws {
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "web-clip", withExtension: "mp4"))
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("reveal-test-\(UUID().uuidString).mp4")
        let second = FileManager.default.temporaryDirectory.appendingPathComponent("reveal-test-\(UUID().uuidString).mp4")
        try FileManager.default.copyItem(at: fixture, to: copy)
        try FileManager.default.copyItem(at: fixture, to: second)
        defer {
            try? FileManager.default.removeItem(at: copy)
            try? FileManager.default.removeItem(at: second)
        }

        let playback = PlaybackController()
        playback.play(file: copy)
        for _ in 0..<50 where playback.player.currentItem?.status != .readyToPlay {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(playback.player.currentItem?.status, .readyToPlay)
        XCTAssertTrue(playback.isLoaded)
        XCTAssertEqual(playback.clip?.purpose, .reveal)

        // Frames actually decode (not just "ready"): pull a pixel buffer while it plays.
        let output = AVPlayerItemVideoOutput(pixelBufferAttributes: nil)
        playback.player.currentItem?.add(output)
        var frames = 0
        for _ in 0..<30 {
            try await Task.sleep(for: .milliseconds(100))
            let time = output.itemTime(forHostTime: CACurrentMediaTime())
            if output.hasNewPixelBuffer(forItemTime: time), output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) != nil { frames += 1 }
        }
        XCTAssertGreaterThan(frames, 0)
        XCTAssertEqual(playback.player.isMuted, true)

        // One player per device: the next clip replaces the item, not the player.
        let player = playback.player
        playback.play(file: second, forcedMuted: true, purpose: .preview)
        XCTAssertTrue(playback.player === player)
        XCTAssertEqual(playback.clip?.purpose, .preview)
        XCTAssertTrue(playback.player.isMuted)

        // Stopping for another purpose leaves this clip alone.
        playback.stop(purpose: .hover)
        XCTAssertEqual(playback.clip?.purpose, .preview)
        playback.stop(purpose: .preview)
        XCTAssertNil(playback.clip)
        XCTAssertNil(playback.player.currentItem)
        XCTAssertFalse(playback.isLoaded)
    }

    func testHoverAndPreviewAreMutedAndRevealFollowsTheChoice() throws {
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "web-clip", withExtension: "mp4"))
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("mute-test-\(UUID().uuidString).mp4")
        try FileManager.default.copyItem(at: fixture, to: copy)
        defer { try? FileManager.default.removeItem(at: copy) }

        let playback = PlaybackController()
        playback.play(file: copy, forcedMuted: true, purpose: .hover)
        XCTAssertTrue(playback.player.isMuted)
        playback.play(file: copy, purpose: .reveal)
        XCTAssertTrue(playback.player.isMuted)  // the user's default is muted
        playback.muted = false
        XCTAssertFalse(playback.player.isMuted)
        playback.play(file: copy, forcedMuted: true, purpose: .preview)
        XCTAssertTrue(playback.player.isMuted)
        playback.stop()
        XCTAssertNil(playback.clip)
    }
}
