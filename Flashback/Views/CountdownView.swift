import SwiftUI

/// "Round 3 of 10" and a big 3 · 2 · 1. While the server is still waiting for
/// the upload it shows the shuffling cards instead of a digit. Nothing else.
struct CountdownView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var layout: RoomLayout
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var round: RoundView? { view.round }
    private var waiting: Bool { round?.isWaiting == true || view.phaseEndsAt == nil }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 18) {
                Text("Round \(round?.index ?? 1) of \(round?.total ?? 1)")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
                    .monospacedDigit()

                if waiting {
                    VStack(spacing: 10) {
                        PolaroidStack(animated: true)
                            .scaleEffect(0.62)
                            .frame(height: 120)
                        Text("Shuffling…")
                            .font(.flCaption)
                            .foregroundStyle(Palette.text2)
                    }
                    .transition(.opacity)
                } else {
                    digits
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(layout.pagePadding)
        .animation(Motion.state(reduceMotion), value: waiting)
    }

    private var digits: some View {
        TimelineView(.periodic(from: .now, by: 0.05)) { _ in
            let left = max(0, (view.phaseEndsAt ?? room.serverNow) - room.serverNow) / 1000
            let digit = max(1, min(3, Int(left.rounded(.up))))
            let fraction = left - left.rounded(.down)
            let scale = reduceMotion ? 1 : 1 + 0.25 * fraction
            Text("\(digit)")
                .font(.fl(120, .black))
                .monospacedDigit()
                .foregroundStyle(Palette.text)
                .contentTransition(.numericText(countsDown: true))
                .scaleEffect(CGFloat(scale))
                .animation(.easeOut(duration: 0.25), value: digit)
                .accessibilityLabel("\(digit)")
        }
    }
}
