import AVFoundation
import Combine
import Foundation

/// Looping, muted-by-default playback for the current reveal. Owned by the
/// store (not a view) so folding or rotating never restarts or loses it. Each
/// clip gets a fresh player so no state from an earlier round can linger.
@MainActor final class PlaybackController: ObservableObject {
    @Published private(set) var player: AVQueuePlayer?
    @Published var muted = true { didSet { player?.isMuted = muted } }
    private var looper: AVPlayerLooper?
    private var file: URL?

    func play(file url: URL) {
        stop()
        file = url
        let player = AVQueuePlayer()
        player.isMuted = muted
        player.preventsDisplaySleepDuringVideoPlayback = true
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        self.player = player
        player.play()
    }

    /// Keeps the last frame visible (results, and while the host has paused).
    func pause() {
        player?.pause()
    }

    /// Continues after a pause.
    func resume() {
        player?.play()
    }

    func stop() {
        player?.pause()
        looper?.disableLooping()
        looper = nil
        player?.removeAllItems()
        player = nil
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
    }
}
