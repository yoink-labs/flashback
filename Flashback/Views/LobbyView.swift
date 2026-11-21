import SwiftUI

/// The lobby. Compact (outer display, phones): one column — code, players, your
/// bunch as a 3-column grid filling the width, settings, and a sticky Ready /
/// Start bar. Wide (inner display, iPad, landscape): two panes meeting at the
/// fold — the bunch is the canvas in the leading pane, sized to fill it; the room
/// controls are the tools in the trailing pane, near the thumb and the vertical
/// bar. Leave and Settings are toolbar items so iOS 27.1 can put them in the bar.
struct LobbyView: View {
    @EnvironmentObject private var room: RoomStore
    @ObservedObject var deck: DeckStore
    var view: RoomView
    var layout: RoomLayout

    @State private var showQR = false
    @State private var confirmLeave = false
    @State private var showSettings = false

    private var mode: MediaMode { view.settings.mediaMode }
    private var isMix: Bool { deck.kinds.count > 1 }
    private var kind: MediaKind { deck.currentStep }

    var body: some View {
        Group {
            if layout.isWide {
                wide
            } else {
                compact
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button {
                    confirmLeave = true
                } label: {
                    Label("Leave", systemImage: "xmark")
                }
                .accessibilityIdentifier("leave")
            }
            if view.isHost {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showSettings = true
                    } label: {
                        Label("Settings", systemImage: "slider.horizontal.3")
                    }
                    .accessibilityIdentifier("settings-toolbar")
                }
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
        // Here, not on the grid: the grid is rebuilt when the device folds, and
        // the preview must stay open.
        .fullScreenCover(item: $deck.previewing) { item in
            DeckPreview(item: item, deck: deck)
        }
        .confirmationDialog("Leave this room?", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("Leave", role: .destructive) { Task { await room.leave() } }
            Button("Stay", role: .cancel) {}
        }
        #if DEBUG
        .onAppear {
            if TipDebugLaunch.value("uiRoute") == "settings" { showSettings = true }
        }
        #endif
    }

    // MARK: - Compact / tall

    private var compact: some View {
        GeometryReader { proxy in
            let pad = layout.pagePadding
            let content = min(proxy.size.width, layout.contentWidth ?? .infinity) - pad * 2
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    codeBlock(centered: true)
                    playerStrip
                    bunchSection(metrics: .filling(width: content, columns: layout.bunchColumns(kind), count: DeckState.size(kind)))
                    settingsRow
                }
                .padding(.horizontal, pad)
                .padding(.top, 8)
                .padding(.bottom, 24)
                .frame(maxWidth: layout.contentWidth)
                .frame(maxWidth: .infinity)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                stickyBar
                    .padding(.horizontal, pad)
                    .frame(maxWidth: layout.contentWidth)
                    .frame(maxWidth: .infinity)
                    .background(Palette.bg)
            }
        }
    }

    // MARK: - Wide

    private var wide: some View {
        TwoPane { size in
            bunchPane(size)
                .padding(.leading, layout.pagePadding)
                .padding(.vertical, 20)
        } trailing: { _ in
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        codeBlock(centered: false)
                        playerList
                        settingsRow
                    }
                    .padding(.top, 20)
                    .padding(.bottom, 20)
                }
                .scrollBounceBehavior(.basedOnSize)
                stickyBar
            }
            .padding(.trailing, layout.pagePadding)
        }
    }

    /// The canvas: header above a grid sized from the pane's width and height
    /// (3 × 4 in a tall pane, 4 × 3 in a wide one; 6 videos as 2 × 3 or 3 × 2).
    private func bunchPane(_ size: CGSize) -> some View {
        let width = max(0, size.width - layout.pagePadding)
        // What sits above and below the grid: vertical padding, header, steps, note.
        var reserved: CGFloat = 40 + BunchHeader.height + Self.sectionSpacing
        if isMix { reserved += BunchSteps.height + Self.sectionSpacing }
        if deck.state.shortfall(kind) != nil || deck.note(kind) != nil { reserved += BunchNote.reservedHeight + Self.sectionSpacing }
        let gridHeight = size.height - reserved
        let metrics = BunchGridMetrics.fitting(width: width, height: gridHeight, count: DeckState.size(kind))
        // In Mix the column keeps the widest step's width, so the step switch
        // doesn't change size when moving between Photos and Videos.
        let columnWidth = deck.kinds
            .map { BunchGridMetrics.fitting(width: width, height: gridHeight, count: DeckState.size($0)).width }
            .max() ?? metrics.width
        return bunchSection(metrics: metrics)
            .frame(width: max(columnWidth, min(width, 320)))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Bunch

    private static let sectionSpacing: CGFloat = 12

    private func bunchSection(metrics: BunchGridMetrics) -> some View {
        VStack(alignment: .leading, spacing: Self.sectionSpacing) {
            if isMix {
                BunchSteps(deck: deck)
            }
            if !isMix || !deck.bunch(kind).items.isEmpty {
                BunchHeader(deck: deck, kind: kind, showsTitle: !isMix)
            }
            // Leading-aligned, so a narrower grid (6 videos) lines up with the header.
            BunchCanvas(deck: deck, kind: kind, metrics: metrics, showsPrivacyNote: kind == deck.kinds.first, actionsAtTop: !layout.isWide)
                .frame(maxWidth: .infinity, alignment: .leading)
            BunchNote(deck: deck, kind: kind, mode: mode)
        }
    }

    // MARK: - Code and share

    @ViewBuilder private func codeBlock(centered: Bool) -> some View {
        VStack(alignment: centered ? .center : .leading, spacing: 12) {
            Button {
                room.copyCode()
            } label: {
                RoomCodeText(code: view.code, size: 44)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Copies the room code")
            .accessibilityIdentifier("room-code-display")

            HStack(spacing: 10) {
                ShareLink(
                    item: RoomCode.joinURL(view.code),
                    subject: Text("Join my Flashback game"),
                    message: Text("Join my Flashback game with code \(view.code)")
                ) {
                    Label("Share invite", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.capsuleFill)
                .accessibilityIdentifier("share-invite")

                Button {
                    showQR = true
                } label: {
                    Label("QR code", systemImage: "qrcode")
                }
                .buttonStyle(.capsuleFill)
                .accessibilityIdentifier("show-qr")
            }
            .frame(maxWidth: 340)
        }
        .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
    }

    // MARK: - Players

    private var playerStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 16) {
                ForEach(view.players) { player in
                    PlayerChip(view: view, player: player)
                }
                inviteCircle(size: 56)
            }
        }
        .scrollClipDisabled()
    }

    private var playerList: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Players · \(view.players.count)/\(view.capacity)")
                .font(.flCaption)
                .foregroundStyle(Palette.text2)
                .monospacedDigit()
            ForEach(view.players) { player in
                PlayerListRow(view: view, player: player)
            }
        }
    }

    private func inviteCircle(size: CGFloat) -> some View {
        ShareLink(
            item: RoomCode.joinURL(view.code),
            subject: Text("Join my Flashback game"),
            message: Text("Join my Flashback game with code \(view.code)")
        ) {
            Image(systemName: "plus")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Palette.text3)
                .frame(width: size, height: size)
                .overlay(Circle().strokeBorder(Palette.text3, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4])))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Invite a player")
    }

    // MARK: - Settings row

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
        HStack(spacing: 10) {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.text2)
            Text(view.settings.summary)
                .font(.flBodyMedium)
                .foregroundStyle(Palette.text)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
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

    /// Mix, photos dealt, videos not yet: the next step is the primary action.
    private var showsNextStep: Bool {
        isMix && kind == .photo
            && deck.bunch(.photo).items.count >= DeckState.photoSize
            && deck.bunch(.video).items.count < DeckState.videoSize
    }

    /// The divider, the caption and the button share one content width, inside
    /// the safe area (never under the iPhone Duo's vertical bar).
    private var stickyBar: some View {
        VStack(spacing: 10) {
            Rectangle()
                .fill(Palette.line)
                .frame(height: 1)
            if let blocker = view.startBlocker, !showsNextStep {
                Text(blocker)
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("start-blocker")
            }
            Group {
                if showsNextStep {
                    Button {
                        deck.step = .video
                        Haptics.tick()
                    } label: {
                        Text("Next: videos")
                    }
                    .buttonStyle(.primary)
                    .accessibilityIdentifier("next-videos")
                } else if view.isHost {
                    Button {
                        Haptics.ready()
                        room.send(.start)
                    } label: {
                        Text("Start game")
                    }
                    .buttonStyle(.primary)
                    .disabled(view.startBlocker != nil || deck.isBusy)
                    .accessibilityIdentifier("start")
                } else {
                    readyButton
                }
            }
            .frame(maxWidth: layout == .compact ? .infinity : 360)
            .frame(maxWidth: .infinity)
        }
        .padding(.bottom, 8)
    }

    /// A complete bunch that is not mid-deal or mid-swap.
    private var deckFits: Bool {
        deck.counts(mode: mode).fits(mode) && !deck.isBusy
    }

    @ViewBuilder private var readyButton: some View {
        if view.me?.ready == true {
            Button {
                Haptics.ready()
                room.setReady(false)
            } label: {
                Label("You're ready", systemImage: "checkmark")
                    .labelStyle(CapsuleLabelStyle())
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
