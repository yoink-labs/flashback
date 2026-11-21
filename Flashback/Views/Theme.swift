import SwiftUI

extension Color {
    /// `Color(hex: 0xFF4F64)`.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// The v2 tokens from docs/DESIGN.md. Dark only, flat background, one accent.
/// There are no gradients anywhere: colour comes from avatars and the accent.
enum Palette {
    static let bg = Color(hex: 0x0E0D12)
    static let surface = Color(hex: 0x1A1820)
    static let surface2 = Color(hex: 0x24212C)
    static let line = Color(hex: 0x2C2935)
    static let text = Color(hex: 0xF5F4F7)
    static let text2 = Color(hex: 0x9C98A8)
    static let text3 = Color(hex: 0x6B6777)
    static let accent = Color(hex: 0xFF4F64)
    static let good = Color(hex: 0x3DDC97)
    static let bad = Color(hex: 0xFF6B6B)
    static let gold = Color(hex: 0xFFC94A)

    /// Twelve vivid colours assigned by join order, everywhere an avatar shows.
    static let playerColors: [Color] = [
        Color(hex: 0xFF6B6B), Color(hex: 0xFFB547), Color(hex: 0xFFE066), Color(hex: 0x6BE675),
        Color(hex: 0x2EE5C5), Color(hex: 0x4FC3FF), Color(hex: 0x7C8CFF), Color(hex: 0xB07CFF),
        Color(hex: 0xFF7AD9), Color(hex: 0xFF9A5A), Color(hex: 0xB7E34A), Color(hex: 0xD9D6E0),
    ]

    static func playerColor(_ index: Int) -> Color {
        let count = playerColors.count
        return playerColors[((index % count) + count) % count]
    }
}

/// SF Pro Rounded roles from the spec.
extension Font {
    /// Rounded system font at an explicit size and weight.
    static func fl(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }

    static var flTitle: Font { .fl(28, .heavy) }
    static var flHeadline: Font { .fl(20, .bold) }
    static var flBody: Font { .fl(17, .regular) }
    static var flBodyMedium: Font { .fl(17, .medium) }
    static var flCaption: Font { .fl(13, .semibold) }
}

/// 4-pt grid spacing from the spec.
enum Spacing {
    static let pageCompact: CGFloat = 20
    static let pageWide: CGFloat = 32
    static let section: CGFloat = 28
    static let row: CGFloat = 56
    static let tileGap: CGFloat = 3
}

enum Radius {
    static let tile: CGFloat = 14
    static let media: CGFloat = 18
}

/// 0.25 s spring for state changes; Reduce Motion fades instead.
enum Motion {
    static func state(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.82)
    }

    /// A slightly softer spring for things that grow (locked-in avatar, count-up).
    static func pop(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.72)
    }

    static func phase(_ reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.86)
    }
}
