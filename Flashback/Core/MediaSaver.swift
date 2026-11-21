import Foundation
import Photos

/// Saves a round's photo or clip to the player's library with add-only access.
/// Local only: it writes the bytes the phone already has; nothing is sent anywhere.
enum MediaSaver {
    enum SaveError: LocalizedError {
        case denied, failed
        var errorDescription: String? {
            switch self {
            case .denied: "Allow Flashback to add to Photos in Settings."
            case .failed: "Couldn't save that one."
            }
        }
    }

    static func save(_ blob: MediaBlob) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw SaveError.denied }

        switch blob.kind {
        case .photo:
            let data = blob.bytes
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
                }
            } catch {
                throw SaveError.failed
            }
        case .video:
            // Photos needs a file for a video: write the clip to a temp file first.
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("flashback-save-\(UUID().uuidString).mp4")
            do {
                try blob.bytes.write(to: url)
            } catch {
                throw SaveError.failed
            }
            defer { try? FileManager.default.removeItem(at: url) }
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
                }
            } catch {
                throw SaveError.failed
            }
        }
    }
}
