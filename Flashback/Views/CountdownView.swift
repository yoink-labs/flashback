import SwiftUI

/// A calm, contained countdown: "Round 3 of 10", then a 96-pt ring draining
/// around a 44-pt digit. While the server waits for the upload the same spot
/// shows the small shuffling cards. Frozen while paused. On wide the countdown
/// sits in the leading pane and the scores fill the trailing one.
struct CountdownView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var layout: RoomLayout

    var body: some View {
        if layout.isWide {
            TwoPane { _ in
                CountdownRing(view: view)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.leading, layout.pagePadding)
            } trailing: { pane in
                ScrollView {
                    StandingsList(view: view)
                        .padding(.vertical, 20)
                        .frame(minHeight: pane.height, alignment: .center)
                }
                .scrollBounceBehavior(.basedOnSize)
                .padding(.trailing, layout.pagePadding)
            }
        } else {
            CountdownRing(view: view)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(layout.pagePadding)
        }
    }
}

struct CountdownRing: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var view: RoomView

    static let size: CGFloat = 96
    /// The server's minimum countdown (COUNTDOWN_MS).
    static let lengthMs: Double = 3000

    private var round: RoundView? { view.round }
    /// No deadline yet means the upload is still on its way.
    private var waiting: Bool { round?.isWaiting == true || !view.hasDeadline }

    var body: some View {
        VStack(spacing: 16) {
            Text("Round \(round?.index ?? 1) of \(round?.total ?? 1)")
                .font(.flCaption)
                .foregroundStyle(Palette.text2)
                .monospacedDigit()

            ZStack {
                if waiting {
                    PolaroidStack(animated: !view.paused)
                        .scaleEffect(0.36)
                        .frame(width: Self.size, height: Self.size)
                        .transition(.opacity)
                } else {
                    ring
                }
            }
            .frame(width: Self.size, height: Self.size)

            Text(waiting ? "Shuffling…" : view.paused ? "Paused" : " ")
                .font(.flCaption)
                .foregroundStyle(Palette.text3)
        }
        .animation(Motion.state(reduceMotion), value: waiting)
        .accessibilityElement(children: .combine)
    }

    private var ring: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 30.0)) { _ in
            let left = view.remainingMs(until: view.phaseEndsAt, now: room.serverNow)
            let digit = max(1, min(3, Int((left / 1000).rounded(.up))))
            let fraction = min(1, max(0, left / Self.lengthMs))
            let withinSecond = (left / 1000) - (left / 1000).rounded(.down)
            ZStack {
                if !reduceMotion {
                    Circle()
                        .stroke(Palette.surface2, lineWidth: 6)
                    Circle()
                        .trim(from: 0, to: CGFloat(fraction))
                        .stroke(Palette.accent, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                Text("\(digit)")
                    .font(.fl(44, .black))
                    .monospacedDigit()
                    .foregroundStyle(Palette.text)
                    .contentTransition(reduceMotion ? .identity : .numericText(countsDown: true))
                    .scaleEffect(reduceMotion || view.paused ? 1 : 1 + 0.06 * CGFloat(withinSecond))
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: digit)
                    .accessibilityLabel("\(digit)")
            }
            .padding(3)
        }
    }
}

/// Read-only scores (rank, avatar, name, total). Fills the countdown's
/// trailing pane on wide and the podium's.
struct StandingsList: View {
    var view: RoomView

    private var ranked: [PlayerView] {
        view.players.sorted { $0.score == $1.score ? view.colorIndex($0.id) < view.colorIndex($1.id) : $0.score > $1.score }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Scores")
                .font(.flCaption)
                .foregroundStyle(Palette.text2)
            ForEach(Array(ranked.enumerated()), id: \.element.id) { index, player in
                HStack(spacing: 10) {
                    Text("\(index + 1)")
                        .font(.fl(15, .bold))
                        .monospacedDigit()
                        .foregroundStyle(index == 0 && player.score > 0 ? Palette.gold : Palette.text3)
                        .frame(width: 20, alignment: .leading)
                    PlayerAvatar(view: view, playerID: player.id, size: 28)
                    Text(player.id == view.you.id ? "You" : player.nickname)
                        .font(.fl(17, .semibold))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(player.score.formatted())
                        .font(.fl(17, .bold))
                        .monospacedDigit()
                        .foregroundStyle(Palette.text)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(player.id == view.you.id ? Palette.surface2 : Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            }
        }
    }
}
