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

/// The small secondary capsules used for Share / QR. `fill` makes a row of
/// them share the width equally, so they are the same size.
struct CapsuleButtonStyle: ButtonStyle {
    var fill = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.fl(15, .semibold))
            .labelStyle(CapsuleLabelStyle())
            .lineLimit(1)
            .padding(.horizontal, 16)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: 44)
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
    static var capsuleFill: CapsuleButtonStyle { CapsuleButtonStyle(fill: true) }
}

/// Icon + title with a fixed icon gap, so capsules in a row line up.
struct CapsuleLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 7) {
            configuration.icon.font(.system(size: 14, weight: .semibold))
            configuration.title
        }
    }
}

/// A 36-pt surface circle with one symbol (44-pt hit area). Used for small
/// actions next to a heading, such as New bunch.
struct IconButtonStyle: ButtonStyle {
    var size: CGFloat = 36
    /// Highlights the one action to take next (accent glyph and ring).
    var emphasized = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(!enabled ? Palette.text3 : emphasized ? Palette.accent : Palette.text)
            .frame(width: size, height: size)
            .background(Palette.surface, in: Circle())
            .overlay {
                if emphasized { Circle().strokeBorder(Palette.accent, lineWidth: 1.5).frame(width: size, height: size) }
            }
            .frame(width: max(44, size), height: max(44, size))
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension ButtonStyle where Self == IconButtonStyle {
    static var icon: IconButtonStyle { IconButtonStyle() }
}

/// 44-pt translucent circle that sits on media (mute, save).
struct MediaCircleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(.black.opacity(configuration.isPressed ? 0.7 : 0.5), in: Circle())
            .contentShape(Circle())
    }
}

extension ButtonStyle where Self == MediaCircleButtonStyle {
    static var mediaCircle: MediaCircleButtonStyle { MediaCircleButtonStyle() }
}

/// Save this round's photo or clip to Photos (reveal and results).
struct SaveMediaButton: View {
    @EnvironmentObject private var room: RoomStore

    var body: some View {
        if room.canSave {
            Button {
                Task { await room.saveCurrentMedia() }
            } label: {
                if room.saving {
                    ProgressView().tint(.white)
                } else {
                    Label("Save to Photos", systemImage: "square.and.arrow.down")
                }
            }
            .buttonStyle(.mediaCircle)
            .disabled(room.saving)
            .accessibilityLabel("Save to Photos")
            .accessibilityIdentifier("save-media")
        }
    }
}

// MARK: - Layout

/// The one way screens pick a `RoomLayout` (Home, Join, the room). Reads the
/// available size like `GeometryReader`, but picks the `RoomLayout`
/// from the size the screen has without the keyboard. On the folded iPhone Duo
/// the keyboard leaves the cover wider than tall, which `forSize` calls wide;
/// switching panes there destroyed the focused text field, so typing a name or
/// a code on the cover was impossible.
struct KeyboardStableLayout<Content: View>: View {
    private let content: (RoomLayout, GeometryProxy) -> Content
    @State private var fullSize: CGSize?

    init(@ViewBuilder content: @escaping (RoomLayout, GeometryProxy) -> Content) {
        self.content = content
    }

    var body: some View {
        GeometryReader { proxy in
            content(RoomLayout.forSize(fullSize ?? proxy.size), proxy)
        }
        .background {
            GeometryReader { full in
                Color.clear
                    .onAppear { fullSize = full.size }
                    .onChange(of: full.size) { _, size in fullSize = size }
            }
            .ignoresSafeArea(.keyboard)
        }
    }
}

/// Two panes that meet at the fold (see `PaneSplit`). On iOS 27.1+ the split
/// follows the iPhone Duo division region (read with `includeInactive`, so the
/// layout already clears the fold before the device bends); elsewhere the width
/// is halved. The gap between the panes straddles the fold, so nothing either
/// pane draws is in the curve.
struct TwoPane<Leading: View, Trailing: View>: View {
    @ViewBuilder var leading: (CGSize) -> Leading
    @ViewBuilder var trailing: (CGSize) -> Trailing

    var body: some View {
        GeometryReader { proxy in
            let split = PaneSplit.make(width: proxy.size.width, fold: Self.fold(proxy))
            let height = proxy.size.height
            HStack(spacing: 0) {
                leading(CGSize(width: split.leading, height: height))
                    .frame(width: split.leading, height: height)
                Color.clear
                    .frame(width: split.gap, height: height)
                    .allowsHitTesting(false)
                trailing(CGSize(width: split.trailing, height: height))
                    .frame(width: split.trailing, height: height)
            }
        }
    }

    static func fold(_ proxy: GeometryProxy) -> CGRect? {
        if #available(iOS 27.1, *) {
            let regions = proxy.reservedRegions(kind: .division, options: .includeInactive)
            return (regions.first { $0.isActive } ?? regions.first)?.frame
        }
        return nil
    }
}

// MARK: - Toast

struct ToastView: View {
    var toast: Toast
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: toast.symbol)
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(toast.isError ? Palette.bad : Palette.good)
                .accessibilityHidden(true)
            Text(toast.text)
                .font(.fl(15, .semibold))
                .foregroundStyle(Palette.text)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if toast.action == .openSettings, let url = URL(string: UIApplication.openSettingsURLString) {
                Button("Settings") { openURL(url) }
                    .font(.fl(15, .bold))
                    .foregroundStyle(Palette.accent)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("toast-settings")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .frame(minHeight: 44)
        .background(Palette.surface2, in: Capsule())
        .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
        .accessibilityElement(children: toast.action == nil ? .combine : .contain)
        .accessibilityAddTraits(.updatesFrequently)
        .onAppear { UIAccessibility.post(notification: .announcement, argument: toast.text) }
    }
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
                    .overlay(alignment: .bottomTrailing) {
                        ItemIcons(items: player.items).offset(x: 7, y: 7)
                    }
                if player.isHost { CrownBadge().offset(x: 6, y: -6) }
            }
            Text(player.nickname)
                .font(.flCaption)
                .foregroundStyle(player.connected ? Palette.text2 : Palette.text3)
                .lineLimit(1)
                .frame(maxWidth: 76)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(player.nickname)\(player.isHost ? ", host" : "")\(player.ready ? ", ready" : "")\(player.items.hasAny ? ", \(player.items.accessibilityLabel)" : "")")
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
            if player.items.hasAny {
                ItemIcons(items: player.items, iconSize: 9)
            }
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
