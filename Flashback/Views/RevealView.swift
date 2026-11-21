import AVKit
import SwiftUI
import UIKit

/// The photo is the hero: media fills its box, a 4-pt timer drains at the top,
/// and every player (including you) is tappable below — no boxes around avatars.
struct RevealView: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var view: RoomView
    var layout: RoomLayout
    @ObservedObject var playback: PlaybackController

    private var round: RoundView { view.round ?? RoundView() }
    private var guessed: Int { round.guessedCount ?? 0 }
    private var guessers: Int { round.guesserCount ?? view.players.count }

    var body: some View {
        GeometryReader { proxy in
            if layout == .wide {
                wide(proxy)
            } else {
                compact(proxy)
            }
        }
    }

    // MARK: - Layouts

    private func compact(_ proxy: GeometryProxy) -> some View {
        VStack(spacing: 0) {
            timerBar
            stage(radius: 0, gravity: .resizeAspectFill)
                .frame(width: proxy.size.width, height: mediaHeight(proxy.size))
                .clipped()
            ScrollView(.vertical, showsIndicators: false) {
                panel(compact: true)
                    .padding(.horizontal, layout.pagePadding)
                    .padding(.top, 14)
                    .padding(.bottom, 20)
            }
        }
    }

    private func wide(_ proxy: GeometryProxy) -> some View {
        VStack(spacing: 0) {
            timerBar
            HStack(spacing: 20) {
                stage(radius: Radius.media, gravity: .resizeAspect)
                    .padding(.leading, 20)
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                GeometryReader { column in
                    ScrollView(.vertical, showsIndicators: false) {
                        panel(compact: false)
                            .padding(.vertical, 20)
                            .frame(minHeight: column.size.height, alignment: .center)
                    }
                }
                .frame(width: 360)
                .frame(maxHeight: .infinity)
                .padding(.trailing, 20)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Phone: media fills the width, capped at 58 % of the height and always
    /// leaving room for the title and the avatar rows.
    private func mediaHeight(_ size: CGSize) -> CGFloat {
        switch layout {
        case .compact: min(size.height * 0.58, max(200, size.height - 260))
        case .tall: min(size.height * 0.55, max(240, size.height - 300))
        case .wide: size.height
        }
    }

    // MARK: - Media

    private func stage(radius: CGFloat, gravity: AVLayerVideoGravity) -> some View {
        ZStack {
            Palette.bg

            if round.kind == .video, let player = playback.player {
                PlayerLayerView(player: player, gravity: gravity)
            } else if let image = room.revealImage {
                if layout == .wide {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .accessibilityLabel("Whose is this?")
                } else {
                    // Fill the box without letting the image's own size grow the
                    // stage (a bare scaledToFill image overflows its frame).
                    Color.clear
                        .overlay {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                        }
                        .clipped()
                        .accessibilityElement()
                        .accessibilityLabel("Whose is this?")
                }
            } else if room.revealFailed {
                VStack(spacing: 12) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(Palette.text2)
                    Text("This one didn't load. Guess anyway or skip.")
                        .font(.flBody)
                        .foregroundStyle(Palette.text2)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
            } else {
                ProgressView().tint(Palette.text2)
            }

            if round.kind == .video {
                VStack {
                    Spacer(minLength: 0)
                    HStack {
                        Spacer(minLength: 0)
                        muteButton
                    }
                }
                .padding(14)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    private var muteButton: some View {
        Button {
            room.setMuted(!playback.muted)
            Haptics.tick()
        } label: {
            Image(systemName: playback.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(.black.opacity(0.5), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(playback.muted ? "Unmute" : "Mute")
        .accessibilityIdentifier("mute")
    }

    // MARK: - Timer

    private var timerBar: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
            let total = max(1, (round.endsAt ?? 0) - (round.revealAt ?? 0))
            let left = max(0, (round.endsAt ?? room.serverNow) - room.serverNow)
            let fraction = min(1, max(0, left / total))
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Rectangle().fill(Palette.line)
                    Rectangle()
                        .fill(left < 5000 ? Palette.bad : Palette.accent)
                        .frame(width: proxy.size.width * CGFloat(fraction))
                        .animation(reduceMotion ? nil : .linear(duration: 0.1), value: fraction)
                }
            }
            .frame(height: 4)
        }
        .frame(height: 4)
    }

    private var secondsLeft: some View {
        TimelineView(.periodic(from: .now, by: 0.25)) { _ in
            let left = max(0, (round.endsAt ?? room.serverNow) - room.serverNow) / 1000
            Text("\(Int(left.rounded(.up)))")
                .font(.flCaption)
                .monospacedDigit()
                .foregroundStyle(Palette.text2)
        }
    }

    // MARK: - The guess column

    private func panel(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 16 : 24) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(round.index)/\(round.total)")
                    .font(.flCaption)
                    .monospacedDigit()
                    .foregroundStyle(Palette.text2)
                Spacer(minLength: 8)
                secondsLeft
            }

            Text(round.yourGuess == nil ? "Whose is it?" : "Locked in")
                .font(.flTitle)
                .foregroundStyle(Palette.text)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .animation(Motion.state(reduceMotion), value: round.yourGuess)

            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: layout.guessColumns),
                spacing: 18
            ) {
                ForEach(view.players) { player in
                    GuessAvatar(player: player, view: view, round: round, enabled: round.canGuess == true) {
                        room.send(.guess(player.id))
                        Haptics.lock()
                    }
                }
            }

            if round.yourGuess != nil {
                Text("\(guessed) of \(guessers) guessed")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(Motion.state(reduceMotion), value: round.yourGuess)
    }
}

/// One player in the guess grid: avatar 56 + name caption, no box.
private struct GuessAvatar: View {
    var player: PlayerView
    var view: RoomView
    var round: RoundView
    var enabled: Bool
    var action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var selected: Bool { round.yourGuess == player.id }
    private var locked: Bool { round.yourGuess != nil || !enabled }
    private var color: Color { Palette.playerColor(view.colorIndex(player.id)) }
    private var label: String { player.id == view.you.id ? "You" : player.nickname }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Avatar(
                    name: player.nickname,
                    size: 56,
                    color: color,
                    dimmed: !player.connected
                )
                .overlay {
                    if selected {
                        Circle()
                            .strokeBorder(Palette.accent, lineWidth: 3)
                            .padding(-4)
                    }
                }
                .scaleEffect(selected ? 1.12 : 1)

                Text(label)
                    .font(.flCaption)
                    .foregroundStyle(selected ? Palette.text : Palette.text2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .opacity(locked && !selected ? 0.35 : 1)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .animation(Motion.pop(reduceMotion), value: selected)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// AVPlayerLayer without controls; the player belongs to the store so layout
/// changes never restart playback.
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer?
    var gravity: AVLayerVideoGravity = .resizeAspect

    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = gravity
        view.playerLayer.player = player
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        view.playerLayer.videoGravity = gravity
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }

    static func dismantleUIView(_ view: LayerView, coordinator: ()) {
        view.playerLayer.player = nil
    }
}
