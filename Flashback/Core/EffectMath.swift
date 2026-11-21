import CoreGraphics
import Foundation

/// Pure maths for the Milestone 4 reveal effects, driven by the server clock so
/// every phone shows the same frame of the animation. Unit tested.
enum EffectMath {
    /// Focus starts at 8 % of the media's shorter side and eases to 0.
    static let focusBlurFraction: CGFloat = 0.08
    /// Streak blur is fully sharp by 75 % of the round (Milestone 5 §5).
    static let blurClearFraction = 0.75

    /// Elapsed time in the reveal, from the server's total and the time left
    /// (`RoomView.remainingMs`, which freezes while paused).
    static func elapsedMs(totalMs: Double, remainingMs: Double) -> Double {
        let total = max(0, totalMs.isFinite ? totalMs : 0)
        let remaining = max(0, remainingMs.isFinite ? remainingMs : 0)
        return min(total, max(0, total - remaining))
    }

    static func progress(elapsedMs: Double, spanMs: Double) -> Double {
        guard spanMs.isFinite, spanMs > 0 else { return 1 }
        return min(1, max(0, elapsedMs / spanMs))
    }

    /// Ease-out cubic: fast at first, settling at the end.
    static func easeOut(_ t: Double) -> Double {
        let t = min(1, max(0, t))
        return 1 - pow(1 - t, 3)
    }

    /// Focus: the blur radius left at `progress` (0 = fully sharp).
    static func focusRadius(shorterSide: CGFloat, progress: Double) -> CGFloat {
        max(0, shorterSide) * focusBlurFraction * CGFloat(1 - easeOut(progress))
    }

    /// Zoom: the scale left at `progress` (1 = back to normal).
    static func zoomScale(target: Double, progress: Double) -> Double {
        1 + (max(1, target) - 1) * (1 - easeOut(progress))
    }

    /// The streak blur's radius: the Milestone 4 base (2/4/7 % of the media's
    /// shorter side) fading linearly to 0 at 75 % of the round (§5):
    /// `base × max(0, 1 − elapsed / (0.75 × timerMs))`.
    static func streakBlurRadius(shorterSide: CGFloat, fraction: CGFloat, elapsedMs: Double, timerMs: Double) -> CGFloat {
        let base = max(0, shorterSide) * max(0, fraction)
        guard timerMs.isFinite, timerMs > 0 else { return 0 }
        let elapsed = elapsedMs.isFinite ? max(0, elapsedMs) : 0
        let fade = max(0, 1 - elapsed / (blurClearFraction * timerMs))
        return base * CGFloat(fade)
    }

    /// The streak effect's blur radius, stacking with focus's (§3, §4). Streak
    /// blur clears over the round; focus eases out over its span.
    static func blurRadius(
        shorterSide: CGFloat,
        streak: YourEffect?,
        round: RoundEffect?,
        progress: Double,
        elapsedMs: Double,
        timerMs: Double
    ) -> CGFloat {
        let side = max(0, shorterSide)
        let streakRadius = streakBlurRadius(shorterSide: side, fraction: streak?.blurFraction ?? 0, elapsedMs: elapsedMs, timerMs: timerMs)
        let focusRadius = round?.kind == .focus ? self.focusRadius(shorterSide: side, progress: progress) : 0
        return streakRadius + focusRadius
    }

    /// The zoom scale, or 1 when the round has no zoom effect.
    static func scale(_ effect: RoundEffect?, progress: Double) -> Double {
        guard let effect, effect.kind == .zoom else { return 1 }
        return zoomScale(target: Double(effect.scale ?? 4), progress: progress)
    }
}
