import UIKit

/// System haptics for ready, countdown, lock-in, correct/incorrect, and podium.
@MainActor enum Haptics {
    static func ready() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func tick() { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    static func reveal() { UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 1) }
    static func lock() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    static func correct() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func incorrect() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    static func podium() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
}
