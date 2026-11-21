import SwiftUI

/// Host settings (docs/MILESTONE3.md section 2): Show, Rounds, Time to guess,
/// Between rounds, Swaps. One aligned label column, each control under its
/// label, hairlines between. Changes go straight to the room, so every guest
/// sees them at once. Done is a toolbar item, so it can move to the vertical bar.
struct SettingsSheet: View {
    @EnvironmentObject private var room: RoomStore
    @Environment(\.dismiss) private var dismiss

    private var settings: RoomSettings { room.view?.settings ?? .defaults }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    row("Show") {
                        EmptyView()
                    } control: {
                        modePicker
                    }
                    divider
                    row("Rounds") {
                        stepper
                    } control: {
                        ChipRow(values: RoomSettings.roundChips, selected: settings.rounds, label: { "\($0)" }) {
                            room.send(.settings(rounds: $0))
                        }
                    }
                    divider
                    row("Time to guess") {
                        value("\(settings.timerSeconds) s")
                    } control: {
                        ChipRow(values: RoomSettings.timerChips, selected: settings.timerSeconds, label: { "\($0)" }) {
                            room.send(.settings(timerSeconds: $0))
                        }
                    }
                    divider
                    row("Between rounds") {
                        value("\(settings.breakSeconds) s")
                    } control: {
                        ChipRow(values: RoomSettings.breakChips, selected: settings.breakSeconds, label: { "\($0)" }) {
                            room.send(.settings(breakSeconds: $0))
                        }
                    }
                    divider
                    row("Swaps") {
                        value(settings.swaps == 1 ? "1 per bunch" : "\(settings.swaps) per bunch")
                    } control: {
                        ChipRow(values: RoomSettings.swapChips, selected: settings.swaps, label: { "\($0)" }) {
                            room.send(.settings(swaps: $0))
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Palette.bg.ignoresSafeArea())
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

    // MARK: - Rows

    private var divider: some View {
        Rectangle().fill(Palette.line).frame(height: 1)
    }

    private func row<Trailing: View, Control: View>(
        _ title: String,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder control: () -> Control
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Text(title)
                    .font(.flBodyMedium)
                    .foregroundStyle(Palette.text)
                Spacer(minLength: 8)
                trailing()
            }
            .frame(minHeight: 40)
            control()
        }
        .padding(.vertical, 16)
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

    private var stepper: some View {
        HStack(spacing: 12) {
            stepButton("minus", label: "Fewer rounds", enabled: settings.rounds > RoomSettings.roundsRange.lowerBound) {
                room.send(.settings(rounds: settings.rounds - 1))
            }
            Text("\(settings.rounds)")
                .font(.fl(20, .heavy))
                .monospacedDigit()
                .foregroundStyle(Palette.text)
                .frame(minWidth: 32)
                .accessibilityLabel("\(settings.rounds) rounds")
            stepButton("plus", label: "More rounds", enabled: settings.rounds < RoomSettings.roundsRange.upperBound) {
                room.send(.settings(rounds: settings.rounds + 1))
            }
        }
    }

    private func stepButton(_ system: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button {
            action()
            Haptics.tick()
        } label: {
            Label(label, systemImage: system)
        }
        .buttonStyle(IconButtonStyle(size: 36))
        .disabled(!enabled)
    }
}

/// Equal-width chips; the selected one is filled with the accent.
struct ChipRow: View {
    var values: [Int]
    var selected: Int
    var label: (Int) -> String
    var action: (Int) -> Void

    var body: some View {
        HStack(spacing: 8) {
            ForEach(values, id: \.self) { value in
                let isSelected = value == selected
                Button {
                    action(value)
                    Haptics.tick()
                } label: {
                    Text(label(value))
                        .font(.fl(15, .bold))
                        .monospacedDigit()
                        .foregroundStyle(isSelected ? .white : Palette.text2)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(isSelected ? Palette.accent : Palette.surface2, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
    }
}
