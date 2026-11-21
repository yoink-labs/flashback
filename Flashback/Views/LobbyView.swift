import SwiftUI

/// Room code once, players as a strip of avatars, your deck, one settings row,
/// and the sticky Ready / Start bar with the blocker caption above it.
struct LobbyView: View {
    @EnvironmentObject private var room: RoomStore
    @ObservedObject var deck: DeckStore
    var view: RoomView
    var layout: RoomLayout

    @State private var showQR = false
    @State private var confirmLeave = false
    @State private var showSettings = false

    var body: some View {
        Group {
            if layout == .wide {
                wide
            } else {
                compact
            }
        }
        .sheet(isPresented: $showQR) {
            QRSheet(code: view.code)
                .environmentObject(room)
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet()
                .environmentObject(room)
        }
        .confirmationDialog("Leave this room?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave", role: .destructive) { Task { await room.leave() } }
            Button("Stay", role: .cancel) {}
        }
    }

    // MARK: - Compact / tall

    private var compact: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    codeHeader(centered: true)
                        .padding(.horizontal, layout.pagePadding)
                    playerStrip
                        .padding(.horizontal, layout.pagePadding)
                    DeckView(
                        deck: deck,
                        mode: view.settings.mediaMode,
                        columns: layout.deckColumns,
                        contentPadding: layout.pagePadding
                    )
                    settingsRow
                        .padding(.horizontal, layout.pagePadding)
                }
                .padding(.top, 4)
                .padding(.bottom, 24)
                .frame(maxWidth: layout.contentWidth)
                .frame(maxWidth: .infinity)
            }
            stickyBar(padding: layout.pagePadding, maxButtonWidth: layout == .compact ? .infinity : 360)
        }
    }

    // MARK: - Wide

    private var wide: some View {
        HStack(alignment: .top, spacing: 32) {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        codeHeader(centered: false)
                        playerList
                        settingsRow
                    }
                    .padding(.bottom, 20)
                }
                stickyBar(padding: 0, maxButtonWidth: 360)
            }
            .frame(width: 380)

            ScrollView {
                DeckView(deck: deck, mode: view.settings.mediaMode, columns: layout.deckColumns)
            }
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .padding(.horizontal, layout.pagePadding)
        .padding(.top, 20)
    }

    // MARK: - Header

    @ViewBuilder private func codeHeader(centered: Bool) -> some View {
        if centered {
            VStack(spacing: 14) {
                HStack {
                    leaveButton
                    Spacer(minLength: 0)
                }
                RoomCodeText(code: view.code, size: 56)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("room-code-display")
                shareCapsules
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 8) {
                    RoomCodeText(code: view.code, size: 56)
                        .accessibilityIdentifier("room-code-display")
                    Spacer(minLength: 0)
                    leaveButton
                }
                shareCapsules
            }
        }
    }

    private var shareCapsules: some View {
        HStack(spacing: 10) {
            ShareLink(
                item: RoomCode.joinURL(view.code),
                subject: Text("Join my Flashback game"),
                message: Text("Join my Flashback game with code \(view.code)")
            ) {
                Text("Share invite")
            }
            .buttonStyle(.capsule)

            Button("QR") { showQR = true }
                .buttonStyle(.capsule)
                .accessibilityLabel("Show QR code")
        }
    }

    private var leaveButton: some View {
        Button {
            confirmLeave = true
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.text2)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Leave room")
    }

    // MARK: - Players

    private var playerStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 18) {
                ForEach(view.players) { player in
                    PlayerChip(view: view, player: player)
                }
                ShareLink(
                    item: RoomCode.joinURL(view.code),
                    subject: Text("Join my Flashback game"),
                    message: Text("Join my Flashback game with code \(view.code)")
                ) {
                    Image(systemName: "plus")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(Palette.text3)
                        .frame(width: 56, height: 56)
                        .overlay(Circle().strokeBorder(Palette.text3, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4])))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Invite a player")
            }
        }
        .scrollClipDisabled()
    }

    private var playerList: some View {
        VStack(spacing: 2) {
            ForEach(view.players) { player in
                PlayerListRow(view: view, player: player)
            }
        }
    }

    // MARK: - Settings row

    private var settingsSummary: String {
        "\(view.settings.mediaMode.label) · \(view.settings.rounds) rounds · \(view.settings.timerSeconds)s"
    }

    private var settingsRow: some View {
        Group {
            if view.isHost {
                Button { showSettings = true } label: {
                    settingsLabel(chevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("game-settings")
            } else {
                settingsLabel(chevron: false)
            }
        }
    }

    private func settingsLabel(chevron: Bool) -> some View {
        HStack(spacing: 8) {
            Text(settingsSummary)
                .font(.flBodyMedium)
                .foregroundStyle(Palette.text)
                .lineLimit(1)
            Spacer(minLength: 0)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.text3)
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: Spacing.row)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
    }

    // MARK: - Sticky bar

    private func stickyBar(padding: CGFloat, maxButtonWidth: CGFloat?) -> some View {
        VStack(spacing: 10) {
            if let blocker = view.startBlocker {
                Text(blocker)
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            if view.isHost {
                Button {
                    Haptics.ready()
                    room.send(.start)
                } label: {
                    Text("Start game")
                }
                .buttonStyle(.primary)
                .disabled(view.startBlocker != nil)
                .frame(maxWidth: maxButtonWidth)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("start")
            } else {
                readyButton
                    .frame(maxWidth: maxButtonWidth)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, padding)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .background(Palette.bg)
        .overlay(alignment: .top) {
            Rectangle().fill(Palette.line).frame(height: 1)
        }
    }

    private var deckFits: Bool {
        view.me?.deck.fits(view.settings.mediaMode) == true
    }

    @ViewBuilder private var readyButton: some View {
        if view.me?.ready == true {
            Button {
                Haptics.ready()
                room.setReady(false)
            } label: {
                Text("I'm ready ✓")
            }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("ready")
        } else {
            Button {
                Haptics.ready()
                room.setReady(true)
            } label: {
                Text("Ready")
            }
            .buttonStyle(.primary)
            .disabled(!deckFits)
            .accessibilityIdentifier("ready")
        }
    }
}

// MARK: - Settings sheet

/// Host settings: Show segmented, Rounds stepper, Timer chips. Changes are sent
/// straight to the room, so every guest sees them at once.
struct SettingsSheet: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.dismiss) private var dismiss

    private let timers = [10, 20, 30, 45, 60]
    private var settings: RoomSettings { room.view?.settings ?? .defaults }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    Text("Game settings").font(.flHeadline)
                    Spacer()
                    Button("Done") { dismiss() }
                        .buttonStyle(.text)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Show")
                        .font(.flBodyMedium)
                        .foregroundStyle(Palette.text2)
                    HStack(spacing: 4) {
                        ForEach(MediaMode.allCases) { mode in
                            Button {
                                room.send(.settings(mediaMode: mode))
                                Haptics.tick()
                            } label: {
                                Text(mode.label)
                                    .font(.fl(15, .bold))
                                    .foregroundStyle(settings.mediaMode == mode ? .white : Palette.text2)
                                    .frame(maxWidth: .infinity, minHeight: 40)
                                    .background(
                                        settings.mediaMode == mode ? Palette.accent : Color.clear,
                                        in: Capsule()
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(settings.mediaMode == mode ? .isSelected : [])
                        }
                    }
                    .padding(3)
                    .background(Palette.surface2, in: Capsule())
                    .accessibilityIdentifier("media-mode")
                }

                HStack(spacing: 16) {
                    Text("Rounds")
                        .font(.flBodyMedium)
                        .foregroundStyle(Palette.text2)
                    Spacer()
                    roundButton(system: "minus", enabled: settings.rounds > 1) {
                        room.send(.settings(rounds: settings.rounds - 1))
                    }
                    Text("\(settings.rounds)")
                        .font(.fl(20, .heavy))
                        .monospacedDigit()
                        .foregroundStyle(Palette.text)
                        .frame(minWidth: 40)
                    roundButton(system: "plus", enabled: settings.rounds < 30) {
                        room.send(.settings(rounds: settings.rounds + 1))
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("Timer")
                        .font(.flBodyMedium)
                        .foregroundStyle(Palette.text2)
                    HStack(spacing: 8) {
                        ForEach(timers, id: \.self) { seconds in
                            Button {
                                room.send(.settings(timerSeconds: seconds))
                                Haptics.tick()
                            } label: {
                                Text("\(seconds)")
                                    .font(.fl(15, .bold))
                                    .monospacedDigit()
                                    .foregroundStyle(settings.timerSeconds == seconds ? .white : Palette.text2)
                                    .frame(maxWidth: .infinity, minHeight: 42)
                                    .background(
                                        settings.timerSeconds == seconds ? Palette.accent : Palette.surface2,
                                        in: Capsule()
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(seconds) seconds")
                            .accessibilityAddTraits(settings.timerSeconds == seconds ? .isSelected : [])
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(Palette.bg.ignoresSafeArea())
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
    }

    private func roundButton(system: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(enabled ? Palette.text : Palette.text3)
                .frame(width: 40, height: 40)
                .background(Palette.surface2, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}
