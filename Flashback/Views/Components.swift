import CoreImage.CIFilterBuiltins
import Foundation
import SwiftUI
import UIKit

// MARK: - Points

/// Points count up over 0.6 s; Reduce Motion shows the final number at once.
struct CountUpText: View {
    var value: Int
    var prefix: String = ""

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var started = Date()
    @State private var finished = false

    var body: some View {
        if reduceMotion || finished {
            Text(prefix + "\(value)")
                .monospacedDigit()
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
                let t = min(1, max(0, context.date.timeIntervalSince(started) / 0.6))
                let eased = 1 - pow(1 - t, 3)
                Text(prefix + "\(Int((Double(value) * eased).rounded()))")
                    .monospacedDigit()
            }
            .onAppear { started = Date() }
            .task {
                try? await Task.sleep(for: .milliseconds(650))
                finished = true
            }
        }
    }
}

// MARK: - Buttons

/// Solid accent fill, white bold 17, 56 tall, capsule. Disabled is a flat
/// surface-2 fill with text-3 type — never a faded gradient.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.fl(17, .bold))
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(enabled ? Color.white : Palette.text3)
            .background(enabled ? Palette.accent : Palette.surface2, in: Capsule())
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Surface fill, primary text, 56 tall, capsule.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.fl(17, .semibold))
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(enabled ? Palette.text : Palette.text3)
            .background(Palette.surface, in: Capsule())
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// The small secondary capsules used for Share / QR and deck actions.
struct CapsuleButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.fl(15, .semibold))
            .lineLimit(1)
            .padding(.horizontal, 18)
            .frame(minHeight: 40)
            .foregroundStyle(enabled ? Palette.text : Palette.text3)
            .background(Palette.surface, in: Capsule())
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// Text-only button in text-2, no fill.
struct TextButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.fl(15, .semibold))
            .foregroundStyle(enabled ? Palette.text2 : Palette.text3)
            .padding(.horizontal, 8)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

extension ButtonStyle where Self == CapsuleButtonStyle {
    static var capsule: CapsuleButtonStyle { CapsuleButtonStyle() }
}

extension ButtonStyle where Self == TextButtonStyle {
    static var text: TextButtonStyle { TextButtonStyle() }
}

// MARK: - Players

/// Circle in the player colour, initial in the page background colour, heavy.
/// Sizes 28 / 40 / 56 / 88. Ready adds a 3-pt good ring; offline is 40 %.
struct Avatar: View {
    var name: String
    var size: CGFloat = 40
    var color: Color = Palette.accent
    var ready: Bool = false
    var ring: Color?
    var dimmed: Bool = false

    var body: some View {
        Text(name.first.map { String($0).uppercased() } ?? "?")
            .font(.fl(size * 0.42, .heavy))
            .foregroundStyle(Palette.bg)
            .frame(width: size, height: size)
            .background(color, in: Circle())
            .overlay {
                if let ring {
                    Circle().strokeBorder(ring, lineWidth: 3)
                } else if ready {
                    Circle().strokeBorder(Palette.good, lineWidth: 3)
                }
            }
            .opacity(dimmed ? 0.4 : 1)
            .accessibilityHidden(true)
    }
}

/// The same avatar (colour by join order) in the lobby, guess grid, results, podium.
struct PlayerAvatar: View {
    var view: RoomView
    var playerID: String
    var size: CGFloat = 40
    var showsReady: Bool = false
    var ring: Color?

    private var player: PlayerView? { view.player(playerID) }

    var body: some View {
        Avatar(
            name: view.name(playerID),
            size: size,
            color: Palette.playerColor(view.colorIndex(playerID)),
            ready: showsReady && player?.ready == true,
            ring: ring,
            dimmed: player?.connected == false
        )
    }
}

/// Small gold crown on a host's avatar.
struct CrownBadge: View {
    var body: some View {
        Image(systemName: "crown.fill")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(Palette.gold)
            .padding(3)
            .background(Palette.bg, in: Circle())
            .accessibilityLabel("Host")
    }
}

/// Avatar 56 with the name caption under it. No boxes around either.
struct PlayerChip: View {
    var view: RoomView
    var player: PlayerView

    var body: some View {
        VStack(spacing: 6) {
            ZStack(alignment: .topTrailing) {
                PlayerAvatar(view: view, playerID: player.id, size: 56, showsReady: true)
                if player.isHost { CrownBadge().offset(x: 6, y: -6) }
            }
            Text(player.nickname)
                .font(.flCaption)
                .foregroundStyle(player.connected ? Palette.text2 : Palette.text3)
                .lineLimit(1)
                .frame(maxWidth: 76)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(player.nickname)\(player.isHost ? ", host" : "")\(player.ready ? ", ready" : "")")
    }
}

/// Wide lobby: avatar 40, name, ready ring, crown. One line per player.
struct PlayerListRow: View {
    var view: RoomView
    var player: PlayerView

    var body: some View {
        HStack(spacing: 12) {
            ZStack(alignment: .topTrailing) {
                PlayerAvatar(view: view, playerID: player.id, size: 40, showsReady: true)
                if player.isHost { CrownBadge().offset(x: 5, y: -5) }
            }
            Text(player.nickname)
                .font(.fl(17, .semibold))
                .foregroundStyle(player.connected ? Palette.text : Palette.text3)
                .lineLimit(1)
            Spacer(minLength: 8)
            if !player.connected {
                Text("away")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text3)
            }
        }
        .frame(minHeight: 52)
    }
}

// MARK: - Room code

/// A room code in the hero face: black, tabular, tracking +2. The only place
/// upper-case is allowed, because a code is upper-case by nature.
struct RoomCodeText: View {
    var code: String
    var size: CGFloat = 56

    var body: some View {
        Text(code)
            .font(.fl(size, .black))
            .monospacedDigit()
            .tracking(2)
            .foregroundStyle(Palette.text)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .accessibilityLabel("Room code \(code.map { String($0) }.joined(separator: " "))")
    }
}

// MARK: - Movement

/// Rank movement on the results list: ↑2 (good), ↓1 (bad), nothing when level.
struct MovementBadge: View {
    var movement: Int

    var body: some View {
        Group {
            if movement > 0 {
                Label("\(movement)", systemImage: "arrow.up")
                    .foregroundStyle(Palette.good)
            } else if movement < 0 {
                Label("\(-movement)", systemImage: "arrow.down")
                    .foregroundStyle(Palette.bad)
            } else {
                Color.clear
            }
        }
        .font(.system(size: 12, weight: .bold, design: .rounded))
        .labelStyle(.titleAndIcon)
        .frame(width: 26, alignment: .trailing)
        .accessibilityLabel(movement > 0 ? "Up \(movement)" : movement < 0 ? "Down \(-movement)" : "No change")
    }
}

// MARK: - The fanned photo stack

/// Three rounded rectangles (120 × 150) rotated −8°, 0°, +8°, filled with
/// solid player colours and a white 4-pt border, like polaroids. Pure shapes.
struct PolaroidStack: View {
    var animated = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = false

    private var colors: [Color] {
        [Palette.playerColor(0), Palette.playerColor(1), Palette.playerColor(4)]
    }

    private var swinging: Bool { animated && !reduceMotion }

    var body: some View {
        // A fan: outer cards behind, the middle card on top and slightly raised,
        // so all three read clearly.
        ZStack {
            card(colors[0], rotation: -10)
                .offset(x: -52, y: 10)
            card(colors[2], rotation: 10)
                .offset(x: 52, y: 10)
            card(colors[1], rotation: 0)
                .offset(x: 0, y: -4)
                .shadow(color: .black.opacity(0.45), radius: 12, y: 6)
        }
        .frame(width: 260, height: 176)
        .onAppear {
            guard swinging else { return }
            withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) {
                phase = true
            }
        }
        .accessibilityHidden(true)
    }

    private func card(_ color: Color, rotation: Double) -> some View {
        RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
            .fill(color)
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .strokeBorder(Color.white, lineWidth: 4)
            }
            .frame(width: 120, height: 150)
            .rotationEffect(.degrees(rotation + (swinging && phase ? rotation / 2 : 0)))
            .offset(y: swinging && phase ? (rotation < 0 ? -3 : rotation > 0 ? 3 : 0) : 0)
    }
}

// MARK: - QR

struct QRCodeView: View {
    var text: String

    var body: some View {
        if let image = Self.render(text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .padding(12)
                .background(.white, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
                .accessibilityLabel("QR code for the join link")
        } else {
            RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                .fill(Palette.surface2)
        }
    }

    static func render(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

struct QRSheet: View {
    var code: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 24) {
            HStack {
                Text("Scan to join").font(.flHeadline)
                Spacer()
                Button("Done") { dismiss() }.buttonStyle(.text)
            }
            QRCodeView(text: RoomCode.joinURL(code).absoluteString)
                .frame(width: 220, height: 220)
            RoomCodeText(code: code, size: 34)
            ShareLink(
                item: RoomCode.joinURL(code),
                subject: Text("Join my Flashback game"),
                message: Text("Join my Flashback game with code \(code)")
            ) {
                Text("Share invite")
            }
            .buttonStyle(.secondary)
            .frame(maxWidth: 320)
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Palette.bg.ignoresSafeArea())
        .presentationDetents([.medium])
        .preferredColorScheme(.dark)
    }
}
