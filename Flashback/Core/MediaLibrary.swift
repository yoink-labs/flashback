import Photos
import UIKit

/// Random picks from the photo library with PhotoKit. Works with full and
/// limited access; with limited access only the photos the player shared are
/// candidates. Library identifiers never leave the device.
enum MediaLibrary {
    enum Access { case full, limited, denied }

    static func requestAccess() async -> Access {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        switch status {
        case .authorized: return .full
        case .limited: return .limited
        default: return .denied
        }
    }

    static var currentAccess: Access {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: .full
        case .limited: .limited
        default: .denied
        }
    }

    /// Up to `count` random assets that fit the mode, never repeating one and
    /// never returning a local identifier in `excluding` (hidden items from any
    /// past game). Videos must be at least a second long.
    static func randomAssets(mode: MediaMode, count: Int, excluding: Set<String> = []) -> [PHAsset] {
        guard count > 0 else { return [] }
        let options = PHFetchOptions()
        options.includeHiddenAssets = false
        switch mode {
        case .photos: options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        case .videos: options.predicate = NSPredicate(format: "mediaType == %d AND duration >= 1", PHAssetMediaType.video.rawValue)
        case .both: options.predicate = NSPredicate(format: "mediaType == %d OR (mediaType == %d AND duration >= 1)", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        }
        let result = PHAsset.fetchAssets(with: options)
        let total = result.count
        guard total > 0 else { return [] }

        var rng = SystemRandomNumberGenerator()
        var picks: [PHAsset] = []
        var seen = Set<Int>()
        var attempts = 0
        // Enough tries to skip hidden identifiers without walking a huge library.
        let limit = max(count * 8, min(total, count * 40))
        while picks.count < count && seen.count < total && attempts < limit {
            attempts += 1
            let index = Int.random(in: 0..<total, using: &rng)
            guard seen.insert(index).inserted else { continue }
            let asset = result.object(at: index)
            if excluding.contains(asset.localIdentifier) { continue }
            picks.append(asset)
        }
        return picks
    }

    /// Random assets of one kind (photos, or videos of at least a second).
    static func randomAssets(kind: MediaKind, count: Int, excluding: Set<String> = []) -> [PHAsset] {
        randomAssets(mode: kind == .photo ? .photos : .videos, count: count, excluding: excluding)
    }

    static func asset(id: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject
    }

    @MainActor static func manageLimitedSelection() {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let root = scene.keyWindow?.rootViewController else { return }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top)
    }
}
