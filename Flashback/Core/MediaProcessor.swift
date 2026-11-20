import AVFoundation
import ImageIO
import Photos
import UniformTypeIdentifiers

/// On-device preparation. Originals never leave the phone:
/// photos become a ≤1600 px JPEG with no metadata (no EXIF/GPS);
/// videos become a 5–8 s (6 s target) H.264 MP4 clip of at most 8 MB with
/// metadata stripped.
enum MediaProcessor {
    // ---- photos ----

    /// Downscales and re-encodes image data as a metadata-free JPEG.
    static func compressPhoto(_ data: Data) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw MediaError.unreadable }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: MediaConstraints.photoMaxPixel,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw MediaError.unreadable }
        for quality in [0.8, 0.65, 0.5, 0.35] {
            let out = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw MediaError.unreadable }
            // No metadata dictionary: nothing from the original (EXIF, GPS, TIFF) is copied.
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw MediaError.unreadable }
            if out.length <= MediaConstraints.photoMaxBytes { return out as Data }
        }
        throw MediaError.photoTooLarge
    }

    static func photo(from asset: PHAsset) async throws -> Data {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        options.version = .current
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
                if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: MediaError.unreadable) }
            }
        }
        return try compressPhoto(data)
    }

    // ---- videos ----

    static func avAsset(from asset: PHAsset) async throws -> AVAsset {
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .mediumQualityFormat
        options.version = .current
        return try await withCheckedThrowingContinuation { continuation in
            PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { avAsset, _, _ in
                if let avAsset { continuation.resume(returning: avAsset) } else { continuation.resume(throwing: MediaError.unreadable) }
            }
        }
    }

    /// Trims a random window and transcodes to H.264 MP4. Returns a temporary file the caller deletes.
    static func clip(from asset: AVAsset, random: Double = .random(in: 0..<1)) async throws -> URL {
        let duration = try await asset.load(.duration).seconds
        let window = try MediaConstraints.clipRange(duration: duration, random: random)
        let range = CMTimeRange(start: CMTime(seconds: window.start, preferredTimescale: 600), duration: CMTime(seconds: window.length, preferredTimescale: 600))
        // 720p first; fall back to 540p if the clip is still too large.
        for preset in [AVAssetExportPreset1280x720, AVAssetExportPreset960x540, AVAssetExportPreset640x480] {
            guard let session = AVAssetExportSession(asset: asset, presetName: preset) else { continue }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("flashback-\(UUID().uuidString).mp4")
            session.timeRange = range
            session.shouldOptimizeForNetworkUse = true
            session.metadata = []
            session.metadataItemFilter = .forSharing()
            do {
                try await session.export(to: url, as: .mp4)
            } catch {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
            if size > 0 && size <= MediaConstraints.videoMaxBytes { return url }
            try? FileManager.default.removeItem(at: url)
        }
        throw MediaError.exportFailed
    }
}
