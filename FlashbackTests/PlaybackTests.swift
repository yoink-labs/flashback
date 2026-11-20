import AVFoundation
import XCTest
@testable import Flashback

/// A clip made by the web app (WebCodecs + mp4-muxer) must play in the iOS reveal.
@MainActor final class PlaybackTests: XCTestCase {
    func testPlaysBrowserMadeClip() async throws {
        let fixture = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "web-clip", withExtension: "mp4"))
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("reveal-test-\(UUID().uuidString).mp4")
        try FileManager.default.copyItem(at: fixture, to: copy)
        let playback = PlaybackController()
        playback.play(file: copy)
        for _ in 0..<50 where playback.player?.currentItem?.status != .readyToPlay {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(playback.player?.currentItem?.status, .readyToPlay)
        // Frames actually decode (not just "ready"): pull a pixel buffer while it plays.
        let output = AVPlayerItemVideoOutput(pixelBufferAttributes: nil)
        playback.player?.currentItem?.add(output)
        var frames = 0
        for _ in 0..<30 {
            try await Task.sleep(for: .milliseconds(100))
            let time = output.itemTime(forHostTime: CACurrentMediaTime())
            if output.hasNewPixelBuffer(forItemTime: time), output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) != nil { frames += 1 }
        }
        XCTAssertGreaterThan(frames, 0)
        XCTAssertEqual(playback.player?.isMuted, true)
        // A second clip gets its own player; the first one is torn down.
        let first = playback.player
        let second = FileManager.default.temporaryDirectory.appendingPathComponent("reveal-test-\(UUID().uuidString).mp4")
        try FileManager.default.copyItem(at: fixture, to: second)
        playback.play(file: second)
        XCTAssertFalse(playback.player === first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
        playback.stop()
        XCTAssertNil(playback.player)
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
    }
}
