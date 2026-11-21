import SwiftUI

// Power-up and shop UI (docs/MILESTONE4.md §5, §6, §9): public item icons by
// avatars, the reveal's power-up bar, and the results shop strip.

// MARK: - Public item icons

/// Small icons by an avatar for what a player holds. Public to everyone (§6).
struct ItemIcons: View {
    var items: PlayerItems
    var iconSize: CGFloat = 8

    var body: some View {
        if items.hasAny {
            HStack(spacing: 2.5) {
                ForEach(items.icons) { icon in
                    HStack(spacing: 0.5) {
                        Image(systemName: icon.symbol)
                            .font(.system(size: iconSize, weight: .bold))
                        if icon.id == ShopItem.fiftyFifty.rawValue, icon.count > 1 {
                            Text("\(icon.count)")
                                .font(.system(size: iconSize, weight: .heavy, design: .rounded))
                                .monospacedDigit()
                        }
                    }
                }
            }
            .foregroundStyle(Palette.text)
            .padding(.horizontal, 4)
            .frame(minHeight: iconSize + 7)
            .background(Palette.bg.opacity(0.92), in: Capsule())
            .overlay(Capsule().strokeBorder(Palette.line, lineWidth: 0.5))
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(items.accessibilityLabel)
        }
    }
}

// MARK: - Reveal power-up bar

/// Under the reveal title, only when relevant: the 50/50 button plus armed
/// Double Down / Shield pills (§9).
struct PowerupBar: View {
    var items: PlayerItems
    var usedFiftyFifty: Bool
    var canUseFiftyFifty: Bool
    var onUseFiftyFifty: () -> Void

    private var showsFiftyFifty: Bool { items.fiftyFifty > 0 || usedFiftyFifty }

    var body: some View {
        if showsFiftyFifty || items.doubleDown > 0 || items.shield > 0 {
            FlowLayout(spacing: 6, lineSpacing: 6) {
                if showsFiftyFifty {
                    FiftyFiftyButton(
                        count: items.fiftyFifty,
                        used: usedFiftyFifty,
                        enabled: canUseFiftyFifty,
                        action: onUseFiftyFifty
                    )
                }
                if items.doubleDown > 0 {
                    PowerupPill(symbol: ShopItem.doubleDown.symbol, text: "Double Down armed")
                }
                if items.shield > 0 {
                    PowerupPill(symbol: ShopItem.shield.symbol, text: "Shield on")
                }
            }
            .accessibilityIdentifier("powerup-bar")
        }
    }
}

/// "50/50 ×1": accent ring while it can be used, quiet once used or guessed.
struct FiftyFiftyButton: View {
    var count: Int
    var used: Bool
    var enabled: Bool
    var action: () -> Void

    private var label: String { used ? "50/50 used" : "50/50 ×\(count)" }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: ShopItem.fiftyFifty.symbol)
                    .font(.system(size: 13, weight: .bold))
                    .accessibilityHidden(true)
                Text(label)
                    .font(.fl(13, .bold))
                    .monospacedDigit()
            }
            .foregroundStyle(enabled ? Palette.text : Palette.text3)
            .padding(.horizontal, 12)
            .frame(minHeight: 34)
            .background(Palette.surface, in: Capsule())
            .overlay {
                Capsule().strokeBorder(enabled ? Palette.accent : Palette.line, lineWidth: 1.5)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityHint(enabled ? "Greys out half the wrong answers" : "")
        .accessibilityIdentifier("fifty-fifty")
    }
}

/// "Double Down armed" / "Shield on".
struct PowerupPill: View {
    var symbol: String
    var text: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Palette.accent)
                .accessibilityHidden(true)
            Text(text)
                .font(.fl(13, .semibold))
        }
        .foregroundStyle(Palette.text2)
        .padding(.horizontal, 10)
        .frame(minHeight: 34)
        .background(Palette.surface, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(text)
    }
}

// MARK: - Results shop strip

/// Three equal cards below the "you" card: icon, name, one-line effect, price,
/// and the disabled reason when it can't be bought (§6, §9).
struct ShopStrip: View {
    var player: PlayerView?
    var shop: ShopView
    var lastBought: ShopItem?
    var paused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "cart.fill")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Palette.text2)
                    .accessibilityHidden(true)
                Text("Shop")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
                Spacer(minLength: 8)
                Text("\(player?.score ?? 0) pts")
                    .font(.flCaption)
                    .monospacedDigit()
                    .foregroundStyle(Palette.text2)
                    .accessibilityIdentifier("shop-points")
            }
            HStack(alignment: .top, spacing: 8) {
                ForEach(ShopItem.allCases) { item in
                    ShopCard(
                        item: item,
                        price: shop.prices.price(item),
                        availability: ShopAvailability.evaluate(
                            item: item,
                            player: player,
                            shop: shop,
                            lastBought: lastBought,
                            paused: paused
                        )
                    )
                }
            }
        }
        .accessibilityIdentifier("shop-strip")
    }
}

private struct ShopCard: View {
    @EnvironmentObject private var room: RoomStore
    var item: ShopItem
    var price: Int
    var availability: ShopAvailability

    private var available: Bool { availability.isAvailable }

    var body: some View {
        Button {
            room.buy(item)
        } label: {
            VStack(spacing: 4) {
                Image(systemName: item.symbol)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(available ? Palette.accent : Palette.text3)
                    .accessibilityHidden(true)
                Text(item.name)
                    .font(.fl(12, .bold))
                    .foregroundStyle(available ? Palette.text : Palette.text3)
                    .lineLimit(1)
                    .minimumScaleFactor(0.65)
                Text(item.caption)
                    .font(.fl(10, .medium))
                    .foregroundStyle(Palette.text3)
                    .multilineTextAlignment(.center)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(height: 13)
                if let reason = availability.reason {
                    Text(reason)
                        .font(.fl(10, .semibold))
                        .foregroundStyle(availability == .bought ? Palette.good : Palette.text3)
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                } else {
                    Text("One per break")
                        .font(.fl(10, .semibold))
                        .foregroundStyle(.clear)
                        .accessibilityHidden(true)
                }
                Text("\(price)")
                    .font(.fl(13, .heavy))
                    .monospacedDigit()
                    .foregroundStyle(available ? Palette.gold : Palette.text3)
            }
            .padding(.horizontal, 5)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: 106)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .strokeBorder(available ? Palette.accent.opacity(0.55) : Color.clear, lineWidth: 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!available)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.name), \(price) points\(availability.reason.map { ", \($0)" } ?? "")")
        .accessibilityIdentifier("shop-\(item.rawValue)")
    }
}
