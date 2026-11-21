import SwiftUI

// Shared building blocks for the Milestone 4 settings sheet: section titles,
// labelled rows, steppers, toggles with expanding content, and choice chips.

struct SettingsSectionTitle: View {
    var text: String

    var body: some View {
        Text(text)
            .font(.fl(13, .bold))
            .foregroundStyle(Palette.text2)
            .padding(.top, 20)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }
}

struct SettingsHairline: View {
    var body: some View {
        Rectangle().fill(Palette.line).frame(height: 1)
    }
}

/// A title on the left, an inline value on the right, and a control under both.
struct SettingsFieldRow<Trailing: View, Control: View>: View {
    var title: String
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var control: () -> Control

    var body: some View {
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
}

/// "− 3 +": one value with two 44-pt hit-area buttons.
struct SettingsStepper: View {
    var value: Int
    var range: ClosedRange<Int>
    var unit: String = ""
    var decreaseLabel: String = "Decrease"
    var increaseLabel: String = "Increase"
    var onChange: (Int) -> Void

    var body: some View {
        HStack(spacing: 10) {
            stepButton("minus", label: decreaseLabel, enabled: value > range.lowerBound) {
                onChange(value - 1)
            }
            Text("\(value)\(unit)")
                .font(.fl(17, .heavy))
                .monospacedDigit()
                .foregroundStyle(Palette.text)
                .frame(minWidth: 34)
                .accessibilityLabel("\(value)\(unit.isEmpty ? "" : " \(unit)")")
            stepButton("plus", label: increaseLabel, enabled: value < range.upperBound) {
                onChange(value + 1)
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

/// A titled toggle; `content` expands under it while it is on (§9).
struct SettingsToggleRow<Content: View>: View {
    var title: String
    @Binding var isOn: Bool
    var caption: String?
    var identifier: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text(title)
                    .font(.flBodyMedium)
                    .foregroundStyle(Palette.text)
                Spacer(minLength: 8)
                Toggle(title, isOn: $isOn)
                    .labelsHidden()
                    .tint(Palette.accent)
                    .accessibilityLabel(title)
                    .accessibilityIdentifier(identifier ?? "toggle-\(title)")
            }
            .frame(minHeight: 40)
            if let caption {
                Text(caption)
                    .font(.flCaption)
                    .foregroundStyle(Palette.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isOn { content() }
        }
        .padding(.vertical, 14)
    }
}

/// Equal-width capsule chips for a small set of values (the settings sheet's
/// segmented controls).
struct ChoiceChips<Value: Hashable>: View {
    var values: [Value]
    var selected: Value
    var label: (Value) -> String
    var spacing: CGFloat = 6
    var action: (Value) -> Void

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                let isSelected = value == selected
                Button {
                    action(value)
                    Haptics.tick()
                } label: {
                    Text(label(value))
                        .font(.fl(13, .bold))
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

/// A small caption row used for an effect's inline label ("Trigger", "After").
struct SettingsInlineLabel: View {
    var text: String

    var body: some View {
        Text(text)
            .font(.fl(13, .semibold))
            .foregroundStyle(Palette.text2)
            .frame(minHeight: 20)
    }
}
