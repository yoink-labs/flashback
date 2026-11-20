import AVFoundation
import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import Flashback

final class MediaConstraintsTests: XCTestCase {
    func testModesAllowKinds() {
        XCTAssertTrue(MediaConstraints.allows(.photos, .photo))
        XCTAssertFalse(MediaConstraints.allows(.photos, .video))
        XCTAssertTrue(MediaConstraints.allows(.videos, .video))
        XCTAssertFalse(MediaConstraints.allows(.videos, .photo))
        XCTAssertTrue(MediaConstraints.allows(.both, .photo) && MediaConstraints.allows(.both, .video))
    }

    func testClipWindowIsAtMostSixSecondsInsideTheVideo() throws {
        let long = try MediaConstraints.clipRange(duration: 60, random: 0.5)
        XCTAssertEqual(long.length, 6)
        XCTAssertEqual(long.start, 27, accuracy: 0.001)
        let end = try MediaConstraints.clipRange(duration: 60, random: 1)
        XCTAssertLessThanOrEqual(end.start + end.length, 60)
        let short = try MediaConstraints.clipRange(duration: 3.5, random: 0.9)
        XCTAssertEqual(short.length, 3.5)
        XCTAssertEqual(short.start, 0)
        XCTAssertThrowsError(try MediaConstraints.clipRange(duration: 0.5, random: 0))
        XCTAssertThrowsError(try MediaConstraints.clipRange(duration: .nan, random: 0))
    }

    func testSizeAndDurationLimits() {
        XCTAssertNoThrow(try MediaConstraints.validate(bytes: 3 * 1024 * 1024, kind: .photo))
        XCTAssertThrowsError(try MediaConstraints.validate(bytes: 3 * 1024 * 1024 + 1, kind: .photo))
        XCTAssertNoThrow(try MediaConstraints.validate(bytes: 8 * 1024 * 1024, kind: .video))
        XCTAssertThrowsError(try MediaConstraints.validate(bytes: 8 * 1024 * 1024 + 1, kind: .video))
        XCTAssertThrowsError(try MediaConstraints.validate(bytes: 0, kind: .video))
        XCTAssertNoThrow(try MediaConstraints.validateClip(duration: 6))
        XCTAssertThrowsError(try MediaConstraints.validateClip(duration: 30))
        XCTAssertThrowsError(try MediaConstraints.validateClip(duration: 0.4))
    }

    func testFitNeverUpscales() {
        XCTAssertEqual(MediaConstraints.fit(CGSize(width: 4032, height: 3024)), CGSize(width: 1600, height: 1200))
        XCTAssertEqual(MediaConstraints.fit(CGSize(width: 800, height: 600)), CGSize(width: 800, height: 600))
        XCTAssertEqual(MediaConstraints.fit(.zero), .zero)
    }

    func testRandomIndicesAreDistinctAndBounded() {
        var rng = SystemRandomNumberGenerator()
        let picks = MediaConstraints.randomIndices(count: 5, total: 100, using: &rng)
        XCTAssertEqual(picks.count, 5)
        XCTAssertEqual(Set(picks).count, 5)
        XCTAssertTrue(picks.allSatisfy { (0..<100).contains($0) })
        XCTAssertEqual(MediaConstraints.randomIndices(count: 5, total: 2, using: &rng).count, 2)
        XCTAssertEqual(MediaConstraints.slots(used: 3), 7)
        XCTAssertEqual(MediaConstraints.slots(used: 12), 0)
    }

    func testPhotoCompressionResizesAndStripsLocation() throws {
        // A 3000×2000 JPEG with GPS metadata.
        let image = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 2000), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { ctx in
            UIColor.systemPink.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 3000, height: 2000))
        }
        let original = NSMutableData()
        let destination = CGImageDestinationCreateWithData(original, UTType.jpeg.identifier as CFString, 1, nil)!
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 37.77, kCGImagePropertyGPSLongitude: 122.41, kCGImagePropertyGPSLatitudeRef: "N", kCGImagePropertyGPSLongitudeRef: "W"]
        CGImageDestinationAddImage(destination, image.cgImage!, [kCGImagePropertyGPSDictionary: gps] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let source = CGImageSourceCreateWithData(original, nil)!
        XCTAssertNotNil((CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])?[kCGImagePropertyGPSDictionary])

        let compressed = try MediaProcessor.compressPhoto(original as Data)
        let out = CGImageSourceCreateWithData(compressed as CFData, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(out, 0, nil) as! [CFString: Any]
        XCTAssertNil(props[kCGImagePropertyGPSDictionary])
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 1600)
        XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, 1067)
        XCTAssertLessThanOrEqual(compressed.count, MediaConstraints.photoMaxBytes)
        XCTAssertThrowsError(try MediaProcessor.compressPhoto(Data("not an image".utf8)))
    }

    func testVideoClipIsShortH264MP4() async throws {
        let source = try await Self.makeVideo(seconds: 10)
        defer { try? FileManager.default.removeItem(at: source) }
        let clip = try await MediaProcessor.clip(from: AVURLAsset(url: source), random: 0.5)
        defer { try? FileManager.default.removeItem(at: clip) }
        let asset = AVURLAsset(url: clip)
        let duration = try await asset.load(.duration).seconds
        XCTAssertEqual(duration, 6, accuracy: 0.3)
        let track = try await XCTUnwrapAsync(try await asset.loadTracks(withMediaType: .video).first)
        let formats = try await track.load(.formatDescriptions)
        XCTAssertEqual(formats.first.map(CMFormatDescriptionGetMediaSubType), kCMVideoCodecType_H264)
        let bytes = try Data(contentsOf: clip).count
        XCTAssertLessThanOrEqual(bytes, MediaConstraints.videoMaxBytes)
        XCTAssertEqual(clip.pathExtension, "mp4")
    }

    /// Writes a short solid-color H.264 movie to a temp file.
    static func makeVideo(seconds: Int) async throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("source-\(UUID().uuidString).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 640, AVVideoHeightKey: 360])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 640, kCVPixelBufferHeightKey as String: 360])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<(seconds * 10) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            CVPixelBufferLockBaseAddress(buffer!, [])
            memset(CVPixelBufferGetBaseAddress(buffer!), Int32(frame * 2 % 255), CVPixelBufferGetDataSize(buffer!))
            CVPixelBufferUnlockBaseAddress(buffer!, [])
            adaptor.append(buffer!, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 10))
        }
        input.markAsFinished()
        await writer.finishWriting()
        return url
    }
}

func XCTUnwrapAsync<T>(_ value: @autoclosure () async throws -> T?, file: StaticString = #filePath, line: UInt = #line) async throws -> T {
    let v = try await value()
    return try XCTUnwrap(v, file: file, line: line)
}
