import SwiftUI

/// "Tip the devs": an optional tip. Nothing in Flashback depends on it.
/// Ported from Wanderer's tip jar and restyled with Flashback's tokens.
struct TipJarView: View {
    @ObservedObject var store: TipJarStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                header
                statusCard
                tipsSection
                footnote
            }
            .padding(.horizontal, Spacing.pageCompact)
            .padding(.vertical, 20)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
            .animation(Motion.state(reduceMotion), value: store.purchaseState)
            .animation(Motion.state(reduceMotion), value: store.loadState)
        }
        .background(Palette.bg.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .fontDesign(.rounded)
        .sensoryFeedback(.success, trigger: store.thanksCount)
        .onChange(of: store.purchaseState) { _, state in announce(state) }
        .task {
            if store.loadState != .loaded { await store.load() }
        }
        .refreshable { await store.load() }
        .accessibilityIdentifier("tip-jar")
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                Image(systemName: "heart.fill")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.pink, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .accessibilityHidden(true)
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.text)
                    .accessibilityIdentifier("tip-jar-done")
            }
            Text("Tip the devs")
                .font(.flTitle)
                .foregroundStyle(Palette.text)
                .accessibilityAddTraits(.isHeader)
            Text("Flashback is free with nothing locked. Tips are optional and unlock nothing.")
                .font(.flBody)
                .foregroundStyle(Palette.text2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Status

    @ViewBuilder
    private var statusCard: some View {
        switch store.purchaseState {
        case .idle, .purchasing:
            EmptyView()
        case .thanks(let tier):
            TipStatusBanner(
                icon: "heart.circle.fill",
                tint: .pink,
                title: "Thank you!",
                message: thanksMessage(for: tier),
                actionTitle: "Done",
                action: store.dismissStatus
            )
            .accessibilityIdentifier("tip-jar-thanks")
            .transition(.opacity.combined(with: .move(edge: .top)))
        case .pending:
            TipStatusBanner(
                icon: "hourglass.circle.fill",
                tint: Palette.gold,
                title: "Waiting for approval",
                message: "Your tip will go through once it's approved, for example by a family organiser. You can leave this screen.",
                actionTitle: "OK",
                action: store.dismissStatus
            )
            .accessibilityIdentifier("tip-jar-pending")
            .transition(.opacity.combined(with: .move(edge: .top)))
        case .failed(let message):
            TipStatusBanner(
                icon: "exclamationmark.triangle.fill",
                tint: Palette.bad,
                title: "The tip didn't go through",
                message: message,
                actionTitle: "Dismiss",
                action: store.dismissStatus
            )
            .accessibilityIdentifier("tip-jar-failed")
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    private func thanksMessage(for tier: TipTier) -> String {
        let name = store.products.first(where: { $0.tier == tier })?.title.lowercased() ?? "tip"
        return "Your \(name) means a lot. Thanks for helping keep Flashback going."
    }

    // MARK: - Tips

    @ViewBuilder
    private var tipsSection: some View {
        switch store.loadState {
        case .idle, .loading where store.products.isEmpty:
            loadingRows
        case .unavailable:
            TipNotice(
                title: "Tips aren't available yet",
                message: "The App Store didn't return any tips for your region. Flashback works the same either way.",
                retry: { Task { await store.load() } }
            )
            .accessibilityIdentifier("tip-jar-unavailable")
        case .failed(let message):
            TipNotice(
                title: "Couldn't load tips",
                message: message,
                retry: { Task { await store.load() } }
            )
        default:
            productRows
        }
    }

    private var productRows: some View {
        VStack(spacing: 0) {
            if !store.canMakePayments {
                paymentsDisabledNote
                Divider().overlay(Palette.line)
            }
            ForEach(Array(store.products.enumerated()), id: \.element.id) { index, product in
                if index > 0 {
                    Divider()
                        .overlay(Palette.line)
                        .padding(.leading, dynamicTypeSize.isAccessibilitySize ? 16 : 72)
                }
                TipRow(
                    product: product,
                    isPurchasing: store.purchaseState == .purchasing(product.tier),
                    isEnabled: store.canMakePayments && !store.isPurchasing
                ) {
                    Haptics.ready()
                    Task { await store.purchase(product) }
                }
            }
        }
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.media, style: .continuous))
    }

    private var paymentsDisabledNote: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "lock.fill")
                .foregroundStyle(Palette.text2)
                .accessibilityHidden(true)
            Text("In-app purchases are turned off on this device, so tips can't be sent from here.")
                .font(.fl(15))
                .foregroundStyle(Palette.text2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }

    private var loadingRows: some View {
        VStack(spacing: 0) {
            ForEach(TipTier.allCases) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Palette.surface2)
                        .frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 6) {
                        Capsule().fill(Palette.surface2).frame(width: 120, height: 14)
                        Capsule().fill(Palette.surface2).frame(height: 11)
                    }
                    Spacer()
                    Capsule().fill(Palette.surface2).frame(width: 72, height: 44)
                }
                .padding(16)
            }
        }
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.media, style: .continuous))
        .overlay { ProgressView().tint(Palette.text2) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading tips")
    }

    private var footnote: some View {
        VStack(spacing: 8) {
            Text("Tips are one-time payments handled by the App Store. They don't renew, and you can tip again any time.")
            Text("Tips go live when Flashback reaches the App Store. In TestFlight betas, Apple runs test purchases, so you won't be charged.")
        }
        .font(.flCaption)
        .foregroundStyle(Palette.text3)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity)
    }

    private func announce(_ state: TipJarStore.PurchaseState) {
        let message: String
        switch state {
        case .thanks: message = "Tip sent. Thank you!"
        case .pending: message = "Tip waiting for approval"
        case .failed(let detail): message = "The tip didn't go through. \(detail)"
        case .idle, .purchasing: return
        }
        AccessibilityNotification.Announcement(message).post()
    }
}

/// One tip: icon, the App Store's name and description, and its price.
private struct TipRow: View {
    let product: TipProduct
    let isPurchasing: Bool
    let isEnabled: Bool
    let action: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: action) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                : AnyLayout(HStackLayout(spacing: 12))
            layout {
                if !dynamicTypeSize.isAccessibilitySize { icon }
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.title)
                        .font(.fl(17, .semibold))
                        .foregroundStyle(Palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                    if !product.description.isEmpty {
                        Text(product.description)
                            .font(.fl(14))
                            .foregroundStyle(Palette.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                priceTag
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 68)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled || isPurchasing ? 1 : 0.55)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(product.title), \(product.displayPrice)")
        .accessibilityValue(isPurchasing ? "Purchasing" : "")
        .accessibilityHint(product.description)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("tip-jar-\(product.tier.rawValue)")
    }

    private var icon: some View {
        Image(systemName: product.tier.symbol)
            .font(.fl(17, .semibold))
            .foregroundStyle(Color.pink)
            .frame(width: 44, height: 44)
            .background(Color.pink.opacity(0.16), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityHidden(true)
    }

    private var priceTag: some View {
        ZStack {
            Text(product.displayPrice)
                .font(.fl(16, .bold))
                .monospacedDigit()
                .opacity(isPurchasing ? 0 : 1)
            if isPurchasing { ProgressView().tint(.white) }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .frame(minWidth: 72, minHeight: 44)
        .background(Palette.accent, in: Capsule())
    }
}

/// Inline outcome of the last tip attempt.
private struct TipStatusBanner: View {
    let icon: String
    let tint: Color
    let title: String
    let message: String
    let actionTitle: String
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.flHeadline)
                        .foregroundStyle(Palette.text)
                    Text(message)
                        .font(.fl(15))
                        .foregroundStyle(Palette.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            Button(actionTitle, action: action).buttonStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.media, style: .continuous))
    }
}

/// "Tips aren't available yet" / "Couldn't load tips", with a retry.
private struct TipNotice: View {
    let title: String
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.flHeadline)
                .foregroundStyle(Palette.text)
            Text(message)
                .font(.fl(15))
                .foregroundStyle(Palette.text2)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again", action: retry)
                .buttonStyle(.capsule)
                .padding(.top, 4)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.media, style: .continuous))
    }
}

// MARK: - Entry points

/// The solid pink "Tip the devs" capsule on Home's top bar (white heart and
/// text, matching Wanderer, Split and yoinklabs.dev).
struct TipTheDevsButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "heart.fill")
                    .font(.system(size: 13, weight: .bold))
                Text("Tip the devs")
                    .font(.fl(15, .bold))
                    .lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(Color.pink, in: Capsule())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tip the devs")
        .accessibilityHint("Opens the optional tip jar")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("tip-the-devs")
    }
}

/// A "Tip the devs" row for About.
struct TipTheDevsRow: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "heart.fill")
                    .foregroundStyle(Color.pink)
                    .frame(width: 28)
                Text("Tip the devs")
                    .font(.flBodyMedium)
                    .foregroundStyle(Palette.text)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.fl(14, .semibold))
                    .foregroundStyle(Palette.text3)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: Spacing.row)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Tip the devs")
        .accessibilityHint("Opens the optional tip jar")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("tip-the-devs-row")
    }
}

#Preview("Tip jar") {
    TipJarView(store: .shared)
}
