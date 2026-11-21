import AVKit
import SwiftUI
import UIKit

/// The photo is the hero: media fills its box, a 4-pt timer drains at the top,
/// and every player (including you) is tappable below — no boxes around avatars.
/// Milestone 4 adds the shared focus/zoom and private streak effects, the
/// effect chips on the media, the power-up bar, and 50/50-eliminated avatars.
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
            stage(radius: 0)
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

    /// Media is the leading pane (full height), guesses the trailing pane; the
    /// gap between them sits on the fold, so no avatar is ever in the curve.
    private func wide(_ proxy: GeometryProxy) -> some View {
        VStack(spacing: 0) {
            timerBar
            TwoPane { _ in
                stage(radius: Radius.media)
                    .padding(.leading, 20)
                    .padding(.vertical, 20)
            } trailing: { pane in
                ScrollView(.vertical, showsIndicators: false) {
                    panel(compact: false)
                        .padding(.vertical, 20)
                        .frame(minHeight: pane.height, alignment: .center)
                }
                .padding(.trailing, 20)
            }
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

    // MARK: - Media and effects

    private func stage(radius: CGFloat) -> some View {
        GeometryReader { proxy in
            ZStack {
                Palette.bg
                mediaBox(in: proxy.size)
                effectChips
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(12)
                mediaControls
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: layout.isWide ? .bottomLeading : .bottomTrailing)
                    .padding(14)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
    }

    /// Milestone 5 §6: the media is shown whole, in a box with its own aspect
    /// ratio, centred in the stage. The letterbox is the stage's dark
    /// background — never a blurred copy of the photo. Every effect attaches
    /// to this box, so its shorter side and zoom origin are the media's own.
    @ViewBuilder private func mediaBox(in stage: CGSize) -> some View {
        let aspect = mediaAspect
        let size = MediaFraming.size(aspect: aspect, in: stage)
        let shorter = min(size.width, size.height)
        content(shorterSide: shorter)
            .frame(width: size.width, height: size.height)
            .clipped()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    /// The photo's or clip's own shape; 4:3 until it is known.
    private var mediaAspect: CGFloat {
        if round.kind == .video, let videoSize = playback.videoSize {
            return MediaFraming.aspect(of: videoSize)
        }
        if let image = room.revealImage {
            return MediaFraming.aspect(of: image.size)
        }
        return MediaFraming.fallbackAspect
    }

    /// A round effect animates; so does a streak blur, which now clears over
    /// the round. Both read the server clock, so every phone shows the same
    /// frame. With Reduce Motion the end state shows at once; greyscale is
    /// static and always shows.
    @ViewBuilder private func content(shorterSide: CGFloat) -> some View {
        if animates, !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { _ in
                mediaContent(effects: effectValues(shorterSide: shorterSide, now: room.serverNow))
            }
        } else {
            mediaContent(effects: effectValues(shorterSide: shorterSide, now: room.serverNow, endState: reduceMotion))
        }
    }

    private var animates: Bool {
        round.effect != nil || round.yourEffect?.kind == .blur
    }

    @ViewBuilder private func mediaContent(effects: MediaEffectValues) -> some View {
        if round.kind == .video, playback.isLoaded, playback.clip?.purpose == .reveal {
            // The box already has the clip's aspect ratio, so `.resizeAspect`
            // shows every pixel with no crop.
            PlayerLayerView(player: playback.player, gravity: .resizeAspect)
                .modifier(MediaEffects(values: effects))
        } else if let image = room.revealImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .accessibilityLabel("Whose is this?")
                .modifier(MediaEffects(values: effects))
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
    }

    /// The blur, desaturation and zoom for this instant, from `serverNow` and
    /// the media box's own shorter side (§5).
    private func effectValues(shorterSide: CGFloat, now: Double, endState: Bool = false) -> MediaEffectValues {
        let timerMs = max(0, (round.endsAt ?? 0) - (round.revealAt ?? 0))
        let remaining = view.remainingMs(until: round.endsAt, now: now)
        let elapsed = EffectMath.elapsedMs(totalMs: timerMs, remainingMs: remaining)
        let progress = endState ? 1 : EffectMath.progress(elapsedMs: elapsed, spanMs: round.effect?.spanMs ?? 0)
        return MediaEffectValues(
            blur: EffectMath.blurRadius(
                shorterSide: shorterSide,
                streak: round.yourEffect,
                round: round.effect,
                progress: progress,
                elapsedMs: elapsed,
                timerMs: timerMs
            ),
            grayscale: round.yourEffect?.kind == .greyscale,
            scale: CGFloat(EffectMath.scale(round.effect, progress: progress)),
            origin: round.effect?.origin ?? CGPoint(x: 0.5, y: 0.5)
        )
    }

    @ViewBuilder private var effectChips: some View {
        if round.yourEffect != nil || round.effect != nil {
            VStack(alignment: .leading, spacing: 6) {
                if let effect = round.yourEffect {
                    MediaEffectChip(text: effect.label, symbol: effect.symbol)
                }
                if let effect = round.effect {
                    MediaEffectChip(text: effect.label, symbol: effect.symbol)
                }
            }
        }
    }

    // Save and mute sit on the media: bottom-trailing on a phone, bottom-leading
    // on wide (away from the fold).
    private var mediaControls: some View {
        HStack(spacing: 10) {
            if layout.isWide { SaveMediaButton() }
            if round.kind == .video { muteButton }
            if !layout.isWide { SaveMediaButton() }
        }
    }

    private var muteButton: some View {
        Button {
            room.setMuted(!playback.muted)
            Haptics.tick()
        } label: {
            Label(playback.muted ? "Unmute" : "Mute", systemImage: playback.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
        }
        .buttonStyle(.mediaCircle)
        .accessibilityLabel(playback.muted ? "Unmute" : "Mute")
        .accessibilityIdentifier("mute")
    }

    // MARK: - Timer

    private var timerBar: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
            let total = max(1, (round.endsAt ?? 0) - (round.revealAt ?? 0))
            let left = view.remainingMs(until: round.endsAt, now: room.serverNow)
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
            let left = view.remainingMs(until: round.endsAt, now: room.serverNow) / 1000
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

            PowerupBar(
                items: view.me?.items ?? .none,
                usedFiftyFifty: !round.eliminated.isEmpty,
                canUseFiftyFifty: room.canUseFiftyFifty,
                onUseFiftyFifty: { room.useFiftyFifty() }
            )

            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: layout.guessColumns),
                spacing: 18
            ) {
                ForEach(view.players) { player in
                    GuessAvatar(
                        player: player,
                        view: view,
                        round: round,
                        eliminated: round.eliminated.contains(player.id),
                        enabled: view.canGuess
                    ) {
                        room.guess(player.id)
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
    var eliminated: Bool
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
                .overlay(alignment: .bottomTrailing) {
                    ItemIcons(items: player.items).offset(x: 6, y: 6)
                }
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
                    .strikethrough(eliminated)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if eliminated {
                    Text("ruled out")
                        .font(.caption2)
                        .foregroundStyle(Palette.text2)
                }
            }
            .saturation(eliminated ? 0 : 1)
            .opacity(eliminated ? 0.45 : locked && !selected ? 0.35 : 1)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(locked || eliminated)
        .animation(Motion.pop(reduceMotion), value: selected)
        .accessibilityLabel(label)
        .accessibilityValue(eliminated ? "Ruled out by your 50/50" : "")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A small dark capsule on the media naming the effect (§3, §4).
private struct MediaEffectChip: View {
    var text: String
    var symbol: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .bold))
                .accessibilityHidden(true)
            Text(text)
                .font(.fl(12, .semibold))
                .lineLimit(2)
                .multilineTextAlignment(.leading)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.black.opacity(0.55), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }
}

/// The effect values applied to the media (before the chips and controls, which
/// must stay readable).
private struct MediaEffectValues: Equatable {
    var blur: CGFloat
    var grayscale: Bool
    var scale: CGFloat
    var origin: CGPoint
}

/// Streak blur/greyscale and the round focus/zoom, stacked (§3, §4).
private struct MediaEffects: ViewModifier {
    var values: MediaEffectValues

    func body(content: Content) -> some View {
        content
            .compositingGroup()
            .blur(radius: values.blur, opaque: true)
            .grayscale(values.grayscale ? 1 : 0)
            .scaleEffect(values.scale, anchor: UnitPoint(x: values.origin.x, y: values.origin.y))
    }
}

/// AVPlayerLayer without controls; the player belongs to the store so layout
/// changes never restart playback. One player is shared by every surface (§8).
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
