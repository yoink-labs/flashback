import SwiftUI

/// The room. Layout depends only on the available size (folded, open wide, open
/// tall); state, timers, bunches, and video playback live in `RoomStore`, so a
/// fold mid-round never loses them.
///
/// Room controls (leave, settings, pause) are `NavigationStack` toolbar items
/// with a title and a symbol, so iOS 27.1 can move them into the iPhone Duo's
/// vertical bar instead of a hand-made row of buttons.
struct RoomScreen: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack {
            KeyboardStableLayout { layout, _ in
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
                    // Soften what is behind the pause overlay so the frozen ring or
                    // standings never ghost through under the "Paused" title.
                    .blur(radius: room.view?.showsPause == true ? 14 : 0)
                    if let view = room.view, view.showsPause {
                        PausedOverlay(view: view, layout: layout)
                            .transition(.opacity)
                    }
                }
                .overlay(alignment: .top) { toast(layout) }
                .animation(Motion.phase(reduceMotion), value: room.view?.phase)
                .animation(Motion.state(reduceMotion), value: room.view?.paused)
                .animation(Motion.state(reduceMotion), value: room.toast)
            }
            .toolbar {
                if showsPauseButton {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            room.pause()
                        } label: {
                            Label("Pause", systemImage: "pause.fill")
                        }
                        .disabled(room.view?.paused == true)
                        .accessibilityIdentifier("pause")
                    }
                }
            }
            .toolbar(toolbarVisible ? .visible : .hidden, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.bg, for: .navigationBar)
        }
    }

    /// Host-only pause during countdown, reveal and results.
    private var showsPauseButton: Bool {
        room.view.map { $0.isHost && $0.isInRound } ?? false
    }

    /// The lobby always has Leave; in game only the host has an item (Pause).
    private var toolbarVisible: Bool {
        room.view?.phase == .lobby || showsPauseButton
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

    /// Toasts are transient: on wide they appear over the trailing pane, the
    /// side that stays visible as the device folds closed. Only a toast with an
    /// action (Settings) takes touches.
    @ViewBuilder private func toast(_ layout: RoomLayout) -> some View {
        if let toast = room.toast {
            Group {
                if layout.isWide {
                    TwoPane { _ in Color.clear.allowsHitTesting(false) } trailing: { _ in
                        ToastView(toast: toast)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    }
                } else {
                    ToastView(toast: toast)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.top, 10)
            .padding(.horizontal, layout.pagePadding)
            .transition(.move(edge: .top).combined(with: .opacity))
            .allowsHitTesting(toast.action != nil)
        }
    }

    @ViewBuilder private var banner: some View {
        if room.connection == .reconnecting || room.connection == .connecting {
            Text(room.connection == .connecting ? "Connecting…" : "Reconnecting…")
                .font(.flCaption)
                .foregroundStyle(Palette.text2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(Palette.bg)
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

/// Calm full-screen pause: "Paused", and for the host Resume (primary, thumb
/// zone) plus End game (confirmed). Guests wait for the host. On wide the
/// controls stay inside the trailing pane, never across the fold.
struct PausedOverlay: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var layout: RoomLayout
    @State private var confirmEnd = false

    var body: some View {
        ZStack {
            Palette.bg.opacity(0.9)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture {}
            if layout.isWide {
                TwoPane { _ in
                    title.frame(maxWidth: .infinity, maxHeight: .infinity)
                } trailing: { _ in
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        controls
                    }
                    .padding(.trailing, layout.pagePadding)
                    .padding(.bottom, 20)
                }
            } else {
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    title
                    Spacer(minLength: 0)
                    controls
                }
                .padding(.horizontal, layout.pagePadding)
                .padding(.bottom, 12)
            }
        }
        .confirmationDialog("End the game for everyone?", isPresented: $confirmEnd, titleVisibility: .visible) {
            Button("End game", role: .destructive) { room.send(.end) }
            Button("Keep playing", role: .cancel) {}
        }
        .accessibilityIdentifier("paused")
    }

    private var title: some View {
        VStack(spacing: 10) {
            Image(systemName: "pause.circle.fill")
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(Palette.text2)
            Text("Paused")
                .font(.flTitle)
                .foregroundStyle(Palette.text)
            if !view.isHost {
                Text("Waiting for \(view.name(view.hostID))")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var controls: some View {
        if view.isHost {
            VStack(spacing: 4) {
                Button {
                    room.resumeGame()
                } label: {
                    Label("Resume", systemImage: "play.fill")
                        .labelStyle(CapsuleLabelStyle())
                }
                .buttonStyle(.primary)
                .accessibilityIdentifier("resume")
                Button("End game") { confirmEnd = true }
                    .buttonStyle(.text)
                    .accessibilityIdentifier("end-game")
            }
            .frame(maxWidth: 360)
            .frame(maxWidth: .infinity)
        }
    }
}
