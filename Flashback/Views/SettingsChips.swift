import SwiftUI

/// The wrapping row of small feature chips under the lobby settings row and in
/// the join preview (docs/MILESTONE4.md §9). One chip per enabled setting.
struct SettingsChipRow: View {
    var settings: RoomSettings

    private var chips: [SettingsChip] { SettingsChip.chips(for: settings) }

    var body: some View {
        if !chips.isEmpty {
            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(chips) { chip in
                    SettingsChipView(chip: chip)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Game features")
            .accessibilityIdentifier("settings-chips")
        }
    }
}

struct SettingsChipView: View {
    var chip: SettingsChip

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: chip.symbol)
                .font(.system(size: 10, weight: .bold))
                .accessibilityHidden(true)
            Text(chip.label)
                .font(.fl(12, .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Palette.text2)
        .padding(.horizontal, 9)
        .frame(minHeight: 26)
        .background(Palette.surface, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(chip.label)
    }
}

/// A left-aligned wrapping layout for chips: the row grows to the next line when
/// it runs out of width. Used instead of a grid so chips keep their natural size.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, maxWidth), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}
