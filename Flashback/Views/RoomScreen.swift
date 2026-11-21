import SwiftUI

/// The room. Layout depends only on the available size (folded, open wide, open
/// tall); state, timers, deck, and video playback live in `RoomStore`, so a fold
/// mid-round never loses them.
struct RoomScreen: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { proxy in
            let layout = RoomLayout.forSize(proxy.size)
            ZStack {
                Palette.bg.ignoresSafeArea()
                VStack(spacing: 0) {
                    banner
                    if let view = room.view {
                        phase(view, layout: layout)
                            .id(view.phase)
                            .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96)))
                    } else {
                        joining
                    }
                }
            }
            .animation(Motion.phase(reduceMotion), value: room.view?.phase)
        }
    }

    @ViewBuilder private func phase(_ view: RoomView, layout: RoomLayout) -> some View {
        switch view.phase {
        case .lobby:
            LobbyView(deck: room.deck, view: view, layout: layout)
        case .countdown:
            CountdownView(view: view, layout: layout)
        case .reveal:
            RevealView(view: view, layout: layout, playback: room.playback)
        case .results:
            ResultsView(view: view, layout: layout, playback: room.playback)
        case .podium, .closed:
            PodiumView(view: view, layout: layout)
        }
    }

    private var joining: some View {
        VStack(spacing: 10) {
            ProgressView().tint(Palette.text2)
            Text("Joining room…")
                .font(.flCaption)
                .foregroundStyle(Palette.text2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var banner: some View {
        if room.connection == .reconnecting || room.connection == .connecting {
            Text(room.connection == .connecting ? "Connecting…" : "Reconnecting…")
                .font(.flCaption)
                .foregroundStyle(Palette.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(Palette.bg)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Palette.line).frame(height: 1)
                }
        }
        if let error = room.error {
            Text(error)
                .font(.flCaption)
                .foregroundStyle(Palette.bad)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(Palette.bg)
                .onTapGesture { room.error = nil }
                .accessibilityIdentifier("room-error")
        }
    }
}
