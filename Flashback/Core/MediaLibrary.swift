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

    /// Up to `count` random assets that fit the mode. Videos must be at least a second long.
    static func randomAssets(mode: MediaMode, count: Int) -> [PHAsset] {
        let options = PHFetchOptions()
        options.includeHiddenAssets = false
        switch mode {
        case .photos: options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        case .videos: options.predicate = NSPredicate(format: "mediaType == %d AND duration >= 1", PHAssetMediaType.video.rawValue)
        case .both: options.predicate = NSPredicate(format: "mediaType == %d OR (mediaType == %d AND duration >= 1)", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
        }
        let result = PHAsset.fetchAssets(with: options)
        var rng = SystemRandomNumberGenerator()
        return MediaConstraints.randomIndices(count: count, total: result.count, using: &rng).map { result.object(at: $0) }
    }

    @MainActor static func manageLimitedSelection() {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let root = scene.keyWindow?.rootViewController else { return }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: top)
    }
}
