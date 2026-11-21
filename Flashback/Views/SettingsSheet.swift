import SwiftUI

/// Host settings (docs/MILESTONE4.md §9): three groups — Game, Effects,
/// Power-ups. Changes go straight to the room, so every guest sees them at
/// once. Done is a toolbar item, so it can move to the vertical bar.
struct SettingsSheet: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.dismiss) private var dismiss

    private var settings: RoomSettings { room.view?.settings ?? .defaults }

    var body: some View {
        NavigationStack {
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        SettingsSectionTitle(text: "Game")
                        gameSection
                        SettingsSectionTitle(text: "Effects")
                            .id("settings-effects")
                        EffectsSettingsSection(settings: settings)
                        SettingsSectionTitle(text: "Power-ups")
                            .id("settings-powerups")
                        PowerupSettingsSection(settings: settings)
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 32)
                    .frame(maxWidth: 560)
                    .frame(maxWidth: .infinity)
                }
                .background(Palette.bg.ignoresSafeArea())
                #if DEBUG
                // The sheet is long; this fixture opens it on the expanded effects.
                .onAppear {
                    guard TipDebugLaunch.value("uiRoute") == "settingsEffects" else { return }
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(350))
                        scroller.scrollTo("settings-effects", anchor: .top)
                    }
                }
                #endif
            }
            .navigationTitle("Game settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.bg, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Label("Done", systemImage: "checkmark")
                    }
                    .accessibilityIdentifier("settings-done")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.bg)
        .preferredColorScheme(.dark)
        .fontDesign(.rounded)
        .accessibilityIdentifier("settings-sheet")
    }

    // MARK: - Game

    private var gameSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsFieldRow(title: "Show") {
                EmptyView()
            } control: {
                modePicker
            }
            divider
            SettingsFieldRow(title: "Rounds") {
                SettingsStepper(
                    value: settings.rounds,
                    range: RoomSettings.roundsRange,
                    decreaseLabel: "Fewer rounds",
                    increaseLabel: "More rounds"
                ) { room.send(.settings(rounds: $0)) }
            } control: {
                ChipRow(values: RoomSettings.roundChips, selected: settings.rounds, label: { "\($0)" }, spacing: 5) {
                    room.send(.settings(rounds: $0))
                }
            }
            divider
            SettingsFieldRow(title: "Time to guess") {
                value("\(settings.timerSeconds) s")
            } control: {
                ChipRow(values: RoomSettings.timerChips, selected: settings.timerSeconds, label: { "\($0)" }) {
                    room.send(.settings(timerSeconds: $0))
                }
            }
            divider
            betweenRounds
            divider
            SettingsFieldRow(title: "Swaps") {
                value(settings.swaps == 1 ? "1 per bunch" : "\(settings.swaps) per bunch")
            } control: {
                ChipRow(values: RoomSettings.swapChips, selected: settings.swaps, label: { "\($0)" }) {
                    room.send(.settings(swaps: $0))
                }
            }
            divider
            SettingsToggleRow(
                title: "Even Split",
                isOn: evenSplitBinding,
                caption: "Everyone deals rounds ÷ players. Every photo gets shown."
            ) {
                EmptyView()
            }
        }
    }

    private var betweenRounds: some View {
        VStack(alignment: .leading, spacing: 6) {
            SettingsFieldRow(title: "Between rounds") {
                value("\(settings.rounds > 1 ? settings.effectiveBreakSeconds : settings.breakSeconds) s")
            } control: {
                ChipRow(values: RoomSettings.breakChips, selected: settings.breakSeconds, label: { "\($0)" }, spacing: 5) {
                    room.send(.settings(breakSeconds: $0))
                }
            }
            if settings.powerups.shop.enabled, settings.breakSeconds < RoomSettings.shopMinBreakSeconds, settings.rounds > 1 {
                Text("Shop rounds last \(RoomSettings.shopMinBreakSeconds) s")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("shop-min-break")
            }
        }
    }

    private var evenSplitBinding: Binding<Bool> {
        Binding(
            get: { settings.evenSplit },
            set: { value in
                room.send(.settings(evenSplit: value))
                Haptics.tick()
            }
        )
    }

    // MARK: - Bits

    private var divider: some View {
        SettingsHairline()
    }

    private func value(_ text: String) -> some View {
        Text(text)
            .font(.fl(15, .semibold))
            .monospacedDigit()
            .foregroundStyle(Palette.text2)
    }

    private var modePicker: some View {
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
                        .background(settings.mediaMode == mode ? Palette.accent : Color.clear, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(settings.mediaMode == mode ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Palette.surface2, in: Capsule())
        .accessibilityIdentifier("media-mode")
    }
}

/// Equal-width chips; the selected one is filled with the accent.
struct ChipRow: View {
    var values: [Int]
    var selected: Int
    var label: (Int) -> String
    var spacing: CGFloat = 8
    var action: (Int) -> Void

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(values, id: \.self) { value in
                let isSelected = value == selected
                Button {
                    action(value)
                    Haptics.tick()
                } label: {
                    Text(label(value))
                        .font(.fl(14, .bold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .foregroundStyle(isSelected ? .white : Palette.text2)
                        .frame(maxWidth: .infinity, minHeight: 38)
                        .background(isSelected ? Palette.accent : Palette.surface2, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
    }
}
