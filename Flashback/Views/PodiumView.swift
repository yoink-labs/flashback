import Foundation
import SwiftUI

/// "Robo wins!", the top three on a 2 – 1 – 3 podium (winner centred and
/// tallest), the rest as compact rows, and Play again / Leave.
struct PodiumView: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var view: RoomView
    var layout: RoomLayout
    @State private var confirmLeave = false

    private var entries: [PodiumEntry] {
        view.podium.sorted { $0.rank < $1.rank }
    }

    private var winner: PodiumEntry? { entries.first }

    private var rest: [PodiumEntry] { entries.filter { $0.rank > 3 } }

    var body: some View {
        ZStack {
            if layout.isWide {
                wide
            } else {
                compact
            }
            if !reduceMotion {
                ConfettiView()
            }
        }
        .confirmationDialog("Leave this room?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave", role: .destructive) { Task { await room.leave() } }
            Button("Stay", role: .cancel) {}
        }
    }

    /// Winner and podium in the leading pane; the full ranking and the actions
    /// in the trailing pane.
    private var wide: some View {
        TwoPane { _ in
            VStack(spacing: 28) {
                title
                podium
            }
            .padding(.leading, layout.pagePadding)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } trailing: { _ in
            VStack(spacing: 0) {
                ScrollView {
                    finalList
                        .padding(.vertical, 20)
                }
                .scrollBounceBehavior(.basedOnSize)
                bottomBar
            }
            .padding(.trailing, layout.pagePadding)
        }
    }

    private var finalList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Final scores")
                .font(.flCaption)
                .foregroundStyle(Palette.text2)
            ForEach(entries) { entry in
                HStack(spacing: 10) {
                    Text("\(entry.rank)")
                        .font(.fl(15, .bold))
                        .monospacedDigit()
                        .foregroundStyle(entry.rank == 1 ? Palette.gold : Palette.text3)
                        .frame(width: 20, alignment: .leading)
                    PlayerAvatar(view: view, playerID: entry.playerID, size: 28)
                    Text(entry.playerID == view.you.id ? "You" : view.name(entry.playerID))
                        .font(.fl(17, .semibold))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(entry.score.formatted())
                        .font(.fl(17, .bold))
                        .monospacedDigit()
                        .foregroundStyle(Palette.text)
                }
                .frame(minHeight: 48)
                .padding(.horizontal, 14)
                .background(entry.playerID == view.you.id ? Palette.surface2 : Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            }
        }
    }

    private var compact: some View {
        ZStack {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(spacing: 28) {
                        title
                        podium
                        remaining
                    }
                    .padding(.horizontal, layout.pagePadding)
                    .padding(.top, 28)
                    .padding(.bottom, 24)
                    .frame(maxWidth: layout == .compact ? 560 : 720)
                    .frame(maxWidth: .infinity)
                }
                bottomBar
                    .padding(.horizontal, layout.pagePadding)
            }
        }
    }

    private var title: some View {
        Text(titleText)
            .font(.fl(32, .heavy))
            .foregroundStyle(Palette.text)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .minimumScaleFactor(0.7)
    }

    private var titleText: String {
        guard let winner else { return "Game over" }
        return winner.playerID == view.you.id ? "You win!" : "\(view.name(winner.playerID)) wins!"
    }

    private var podium: some View {
        HStack(alignment: .bottom, spacing: 12) {
            // Only places that exist, so two players sit centred (2 – 1).
            ForEach([2, 1, 3].filter { place in entries.contains { $0.rank == place } }, id: \.self) { place in
                if let entry = entries.first(where: { $0.rank == place }) {
                    PodiumColumn(
                        view: view,
                        entry: entry,
                        avatarSize: place == 1 ? 88 : 56,
                        blockHeight: place == 1 ? 132 : place == 2 ? 92 : 72
                    )
                } else {
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .frame(height: 1)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var remaining: some View {
        if !rest.isEmpty {
            VStack(spacing: 6) {
                ForEach(rest) { entry in
                    HStack(spacing: 10) {
                        Text("\(entry.rank)")
                            .font(.fl(15, .bold))
                            .monospacedDigit()
                            .foregroundStyle(Palette.text3)
                            .frame(width: 20, alignment: .leading)
                        PlayerAvatar(view: view, playerID: entry.playerID, size: 28)
                        Text(view.name(entry.playerID))
                            .font(.fl(17, .semibold))
                            .foregroundStyle(Palette.text)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(entry.score.formatted())
                            .font(.fl(17, .bold))
                            .monospacedDigit()
                            .foregroundStyle(Palette.text)
                    }
                    .frame(minHeight: 48)
                    .padding(.horizontal, 14)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
                }
            }
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 4) {
            if view.isHost {
                Button {
                    room.send(.playAgain)
                } label: {
                    Text("Play again")
                }
                .buttonStyle(.primary)
                .frame(maxWidth: layout == .compact ? .infinity : 360)
                .accessibilityIdentifier("play-again")
            }
            Button("Leave") { confirmLeave = true }
                .buttonStyle(.text)
                .accessibilityIdentifier("podium-leave")
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Palette.bg)
    }
}

private struct PodiumColumn: View {
    var view: RoomView
    var entry: PodiumEntry
    var avatarSize: CGFloat
    var blockHeight: CGFloat

    var body: some View {
        VStack(spacing: 7) {
            PlayerAvatar(view: view, playerID: entry.playerID, size: avatarSize)
            Text(view.name(entry.playerID))
                .font(.fl(15, .semibold))
                .foregroundStyle(Palette.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(entry.score.formatted())
                .font(.fl(20, .heavy))
                .monospacedDigit()
                .foregroundStyle(Palette.text)

            ZStack {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .fill(Palette.surface)
                Text("\(entry.rank)")
                    .font(.fl(24, .heavy))
                    .monospacedDigit()
                    .foregroundStyle(Palette.text3)
            }
            .frame(maxWidth: .infinity)
            .frame(height: blockHeight)
            .overlay(alignment: .top) {
                if entry.rank == 1 {
                    Rectangle()
                        .fill(Palette.gold)
                        .frame(height: 3)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// A single 2.8-second burst of player-coloured confetti. Purely decorative.
private struct ConfettiView: View {
    @State private var done = false
    @State private var started = Date()

    var body: some View {
        Group {
            if done {
                Color.clear
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                    Canvas { context, size in
                        let elapsed = timeline.date.timeIntervalSince(started)
                        guard elapsed < 2.8 else { return }
                        for index in 0..<42 {
                            let seed = Double(index)
                            let x = size.width * CGFloat((seed * 0.618_033_988_75).truncatingRemainder(dividingBy: 1))
                            let delay = (seed * 0.137).truncatingRemainder(dividingBy: 0.6)
                            let life = elapsed - delay
                            guard life > 0, life < 2.4 else { continue }

                            let speed = 150 + (seed.truncatingRemainder(dividingBy: 7)) * 28
                            let y = -20 + CGFloat(life * speed)
                            let sway = sin(life * 2.4 + seed) * 22
                            let width = 4 + seed.truncatingRemainder(dividingBy: 3)
                            let height = 7 + seed.truncatingRemainder(dividingBy: 5)
                            let alpha = life > 2.0 ? max(0, (2.4 - life) / 0.4) : 1
                            let color = Palette.playerColors[index % Palette.playerColors.count]

                            let rect = CGRect(
                                x: x + CGFloat(sway),
                                y: y,
                                width: CGFloat(width),
                                height: CGFloat(height)
                            )
                            context.fill(
                                Path(roundedRect: rect, cornerRadius: 1.5),
                                with: .color(color.opacity(alpha))
                            )
                        }
                    }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(2.9))
            done = true
        }
    }
}
