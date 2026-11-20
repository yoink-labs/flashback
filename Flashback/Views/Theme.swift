import SwiftUI

enum Palette {
    static let accent = Color(red: 1, green: 0.365, blue: 0.561)
    static let sun = Color(red: 1, green: 0.81, blue: 0.29)
    static let cool = Color(red: 0.486, green: 0.906, blue: 1)
    static let good = Color(red: 0.35, green: 0.89, blue: 0.63)
    static let bad = Color(red: 1, green: 0.48, blue: 0.48)
    static let night = Color(red: 0.08, green: 0.05, blue: 0.15)
    static let backdrop = LinearGradient(colors: [Color(red: 0.23, green: 0.11, blue: 0.42), night, Color(red: 0.35, green: 0.09, blue: 0.25)], startPoint: .topLeading, endPoint: .bottomTrailing)
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(.white)
            .background(LinearGradient(colors: [Palette.accent, Color(red: 1, green: 0.54, blue: 0.36)], startPoint: .leading, endPoint: .trailing), in: Capsule())
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle { static var primary: PrimaryButtonStyle { .init() } }

struct Avatar: View {
    var name: String
    var size: CGFloat = 34
    var body: some View {
        Text(name.first.map { String($0).uppercased() } ?? "?")
            .font(.system(size: size * 0.45, weight: .heavy, design: .rounded))
            .foregroundStyle(Palette.night)
            .frame(width: size, height: size)
            .background(LinearGradient(colors: [Palette.cool, Color(red: 0.55, green: 0.43, blue: 1)], startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())
            .accessibilityHidden(true)
    }
}
