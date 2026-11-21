import CoreGraphics
import Foundation

/// Limits shared with the Worker (worker/src/media.ts) and the web app (web/src/media.ts).
enum MediaConstraints {
    static let photoMaxBytes = 3 * 1024 * 1024
    /// Long edge of an uploaded photo. Small payloads keep the Durable Object cheap.
    static let photoMaxPixel: CGFloat = 1440
    static let photoQuality = 0.78
    static let videoMaxBytes = 8 * 1024 * 1024
    static let clipTargetSeconds = 6.0
    static let clipMinSeconds = 1.0
    static let clipMaxSeconds = 8.0

    static func allows(_ mode: MediaMode, _ kind: MediaKind) -> Bool {
        switch mode { case .both: true; case .photos: kind == .photo; case .videos: kind == .video }
    }

    /// The clip window: up to 6 s starting at `random` (0..<1) through the playable range.
    static func clipRange(duration: Double, random: Double) throws -> (start: Double, length: Double) {
        guard duration.isFinite, duration >= clipMinSeconds else { throw MediaError.tooShort }
        let length = min(clipTargetSeconds, duration)
        let start = (duration - length) * min(max(random, 0), 0.999_999)
        return (start, length)
    }

    /// Pixel size that fits within `maxPixel` on the long edge, never upscaling.
    static func fit(_ size: CGSize, maxPixel: CGFloat = photoMaxPixel) -> CGSize {
        guard size.width > 0, size.height > 0 else { return .zero }
        let scale = min(1, maxPixel / max(size.width, size.height))
        return CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    }

    static func validate(bytes: Int, kind: MediaKind) throws {
        if bytes == 0 { throw MediaError.empty }
        if bytes > (kind == .photo ? photoMaxBytes : videoMaxBytes) { throw kind == .photo ? MediaError.photoTooLarge : MediaError.clipTooLarge }
    }

    static func validateClip(duration: Double) throws {
        guard duration >= clipMinSeconds, duration <= clipMaxSeconds + 0.5 else { throw MediaError.clipLength }
    }

    /// Distinct random indices into `total` items, at most `count`.
    static func randomIndices<G: RandomNumberGenerator>(count: Int, total: Int, using rng: inout G) -> [Int] {
        Array(Array(0..<total).shuffled(using: &rng).prefix(max(0, count)))
    }
}

enum MediaError: LocalizedError, Equatable {
    case empty, photoTooLarge, clipTooLarge, clipLength, tooShort, unreadable, exportFailed, noAccess, nothingFound(MediaMode), notAllowed(MediaMode)
    var errorDescription: String? {
        switch self {
        case .empty: "That file is empty."
        case .photoTooLarge: "That photo is too large even after compressing."
        case .clipTooLarge: "That clip is still over 8 MB. Try a shorter video."
        case .clipLength: "Video clips must be between 1 and 8 seconds."
        case .tooShort: "That video is too short."
        case .unreadable: "Couldn't read that photo or video."
        case .exportFailed: "Couldn't make a clip from that video."
        case .noAccess: "Flashback can't see your photos. Allow access in Settings, or choose items yourself."
        case .nothingFound(let mode): mode == .videos ? "No videos found in the photos Flashback can see." : mode == .photos ? "No photos found in the photos Flashback can see." : "No photos or videos found in the library Flashback can see."
        case .notAllowed(let mode): mode == .photos ? "The host chose Photos only." : "The host chose Videos only."
        }
    }
}
