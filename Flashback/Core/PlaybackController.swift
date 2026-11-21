import AVFoundation
import Combine
import Foundation
import SwiftUI

/// One shared `AVPlayer` for the whole app (docs/MILESTONE4.md §8): deck tile
/// hover, the full-screen deck preview, the reveal, and the results thumbnail
/// all attach their own layer to this one player, so at most one clip ever
/// plays and folding never restarts it. The store owns it.
@MainActor final class PlaybackController: ObservableObject {
    enum Purpose: Equatable {
        /// The current reveal (follows the user's mute choice, pauses on results).
        case reveal
        /// The full-screen deck preview (always muted, looping).
        case preview
        /// Inline hover in a deck tile on a pointer device (muted, looping).
        case hover
    }

    struct Clip: Equatable {
        var id: String
        var purpose: Purpose
    }

    /// The one player. Created once; a new clip replaces its item, never the player.
    let player = AVQueuePlayer()
    /// The clip loaded right now (nil when stopped).
    @Published private(set) var clip: Clip?
    /// An item is loaded and can be shown (the layer is safe to render).
    @Published private(set) var isLoaded = false
    /// The player's mute choice for reveals; hover and the preview stay muted.
    @Published var muted = true {
        didSet { player.isMuted = effectiveMuted }
    }

    private var looper: AVPlayerLooper?
    private var forcedMuted = false

    private var effectiveMuted: Bool { forcedMuted || muted }

    init() {
        player.isMuted = muted
        player.preventsDisplaySleepDuringVideoPlayback = true
        player.actionAtItemEnd = .pause
    }

    /// Plays a local clip, looping by default. `forcedMuted` is for hover and
    /// the deck preview, which are always silent.
    func play(file url: URL, loop: Bool = true, forcedMuted: Bool = false, purpose: Purpose = .reveal, id: String? = nil) {
        play(AVPlayerItem(url: url), loop: loop, forcedMuted: forcedMuted, purpose: purpose, id: id ?? url.lastPathComponent)
    }

    func play(_ item: AVPlayerItem, loop: Bool = true, forcedMuted: Bool = false, purpose: Purpose = .reveal, id: String? = nil) {
        teardownItems()
        self.forcedMuted = forcedMuted
        player.isMuted = effectiveMuted
        if loop {
            looper = AVPlayerLooper(player: player, templateItem: item)
        } else {
            player.insert(item, after: nil)
        }
        clip = Clip(id: id ?? UUID().uuidString, purpose: purpose)
        isLoaded = true
        player.play()
    }

    /// Keeps the last frame visible (results, and while the host has paused).
    func pause() { player.pause() }

    /// Continues after a pause.
    func resume() { player.play() }

    /// Detaches the current clip. With a `purpose`, only that purpose is
    /// stopped, so a hover ending can't kill a reveal.
    func stop(purpose: Purpose? = nil) {
        if let purpose, clip?.purpose != purpose { return }
        teardownItems()
        clip = nil
        isLoaded = false
        forcedMuted = false
    }

    private func teardownItems() {
        player.pause()
        looper?.disableLooping()
        looper = nil
        player.removeAllItems()
    }
}
