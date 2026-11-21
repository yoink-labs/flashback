import CoreGraphics
import Foundation

// Milestone 5 (docs/MILESTONE5.md): the fair-reveal contract's pure pieces —
// the clock, the guess clock, the local-reveal decision, and media framing.
// Kept small and free of I/O so every rule is unit tested.

// MARK: - Monotonic local clock (§2)

/// A clock that reads wall time once and advances with a monotonic source, so
/// an NTP or manual clock change never moves a running countdown. `serverNow`
/// is this plus the measured offset.
struct MonotonicClock {
    private let anchorWallMs: Double
    private let anchorUptime: Double
    private let uptime: () -> Double

    init(
        now: Double = Date().timeIntervalSince1970 * 1000,
        uptime: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.anchorWallMs = now
        self.anchorUptime = uptime()
        self.uptime = uptime
    }

    func nowMs() -> Double {
        anchorWallMs + (uptime() - anchorUptime) * 1000
    }
}

// MARK: - Clock sync (§2)

/// The last 8 ping samples, using the offset of the lowest-RTT one:
/// `rtt = t1 − t0`, `offset = serverNow + rtt / 2 − t1`.
struct ClockOffsetEstimator: Equatable {
    static let maxSamples = 8

    struct Sample: Equatable {
        var rtt: Double
        var offset: Double
    }

    private(set) var samples: [Sample] = []

    /// Records one pong. Ignores samples that aren't finite.
    @discardableResult
    mutating func record(sentAt t0: Double, receivedAt t1: Double, serverNow: Double) -> Sample? {
        guard t0.isFinite, t1.isFinite, serverNow.isFinite else { return nil }
        let rtt = max(0, t1 - t0)
        let sample = Sample(rtt: rtt, offset: serverNow + rtt / 2 - t1)
        samples.append(sample)
        if samples.count > Self.maxSamples {
            samples.removeFirst(samples.count - Self.maxSamples)
        }
        return sample
    }

    /// The offset of the fastest round trip, or nil until the first pong.
    var offset: Double? {
        samples.min { $0.rtt < $1.rtt }?.offset
    }

    var hasSample: Bool { !samples.isEmpty }

    mutating func reset() { samples.removeAll() }
}

// MARK: - Scheduled reveal (§3)

/// Whether this device should flip to the reveal on its own, without waiting
/// for the server's `reveal` state.
enum LocalReveal {
    static func shouldReveal(
        phase: Phase,
        paused: Bool,
        revealAt: Double?,
        serverNow: Double,
        mediaReady: Bool
    ) -> Bool {
        guard phase == .countdown, !paused, mediaReady else { return false }
        guard let revealAt, revealAt.isFinite, serverNow.isFinite else { return false }
        return serverNow >= revealAt
    }
}

// MARK: - Guess timing (§4)

enum GuessTiming {
    /// `serverNow` at the tap − `max(revealAt, serverNow when this device first
    /// displayed the media)`, clamped at 0. Paused time is excluded because the
    /// server moves `revealAt` on resume and clients read the latest view.
    static func elapsedMs(tapAt: Double, revealAt: Double?, firstShownAt: Double?) -> Double {
        guard tapAt.isFinite else { return 0 }
        let start = [revealAt, firstShownAt]
            .compactMap { $0 }
            .filter { $0.isFinite }
            .max()
        guard let start else { return 0 }
        return max(0, tapAt - start)
    }
}

// MARK: - Media framing (§6)

/// The box the media sits in: its own aspect ratio, as large as fits, centred
/// in the stage. Effects attach to this box, never the screen.
enum MediaFraming {
    /// Used until the photo is decoded or the clip's size is known.
    static let fallbackAspect: CGFloat = 4.0 / 3.0

    static func aspect(of size: CGSize?) -> CGFloat {
        guard let size, size.width > 0, size.height > 0 else { return fallbackAspect }
        return size.width / size.height
    }

    /// The largest box with `aspect` that fits inside `stage`.
    static func size(aspect: CGFloat, in stage: CGSize) -> CGSize {
        guard aspect > 0, aspect.isFinite, stage.width > 0, stage.height > 0 else { return .zero }
        let width = min(stage.width, stage.height * aspect)
        return CGSize(width: width, height: width / aspect)
    }
}
