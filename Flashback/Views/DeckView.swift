import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

// "Your bunch": 12 photos and/or 6 videos the player is happy to show. Tap a
// tile to swap it (uses one swap), hold it for a full-screen look, New bunch to
// deal again. In Mix there are two steps, Photos then Videos.

// MARK: - Header

/// Mix: the two-segment step switch ("Photos 12/12 ✓" · "Videos 6/6").
struct BunchSteps: View {
    static let height: CGFloat = 46
    @ObservedObject var deck: DeckStore

    var body: some View {
        HStack(spacing: 4) {
            ForEach(deck.kinds, id: \.self) { kind in
                let count = deck.bunch(kind).items.count
                let size = DeckState.size(kind)
                let selected = deck.currentStep == kind
                Button {
                    deck.step = kind
                    Haptics.tick()
                } label: {
                    HStack(spacing: 6) {
                        Text(kind == .photo ? "Photos" : "Videos")
                        Text("\(count)/\(size)")
                            .monospacedDigit()
                            .foregroundStyle(selected ? Color.white.opacity(0.8) : Palette.text3)
                        if count >= size {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .heavy))
                                .foregroundStyle(selected ? .white : Palette.good)
                        }
                    }
                    .font(.fl(15, .bold))
                    .foregroundStyle(selected ? .white : Palette.text2)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(selected ? Palette.accent : Color.clear, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(kind == .photo ? "Photos" : "Videos"), \(count) of \(size)")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(3)
        .frame(height: Self.height)
        .background(Palette.surface2, in: Capsule())
        .accessibilityIdentifier("bunch-steps")
    }
}

/// "Your bunch" (or nothing in Mix, where the steps say it), the swap counter,
/// and the New bunch / Pick more icon buttons, all on one line.
struct BunchHeader: View {
    static let height: CGFloat = 44
    @ObservedObject var deck: DeckStore
    var kind: MediaKind
    var showsTitle: Bool

    private var bunch: Bunch { deck.bunch(kind) }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if showsTitle {
                Text("Your bunch")
                    .font(.flHeadline)
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            if !bunch.items.isEmpty {
                if !showsTitle { swapsLabel }
                Spacer(minLength: 4)
                if showsTitle { swapsLabel }
                if bunch.source == .picked {
                    BunchPicker(deck: deck, kind: kind) {
                        Label(kind == .photo ? "Pick photos" : "Pick videos", systemImage: kind == .photo ? "photo.badge.plus" : "video.badge.plus")
                    }
                    .buttonStyle(.icon)
                    .accessibilityIdentifier("pick-more")
                }
                Button {
                    Haptics.tick()
                    Task { await deck.deal(kind) }
                } label: {
                    if deck.isDealing(kind) {
                        ProgressView().tint(Palette.text2)
                    } else {
                        Label("New bunch", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
                // Out of swaps: New bunch is the way on, so it takes the accent.
                .buttonStyle(IconButtonStyle(emphasized: bunch.swapsLeft == 0))
                .disabled(deck.isDealing(kind))
                .accessibilityHint(bunch.swapsLeft == 0 ? "No swaps left. Deals a fresh bunch with new swaps." : "Deals a fresh bunch")
                .accessibilityIdentifier("new-bunch")
            } else {
                Spacer(minLength: 0)
            }
        }
        .frame(height: Self.height)
    }

    private var swapsLabel: some View {
        Text(swapsText)
            .font(.flCaption)
            .monospacedDigit()
            .foregroundStyle(bunch.swapsLeft == 0 ? Palette.accent : Palette.text2)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .accessibilityIdentifier("swaps-left")
    }

    private var swapsText: String {
        switch bunch.swapsLeft {
        case 0: "No swaps left"
        case 1: "1 swap left"
        default: "\(bunch.swapsLeft) swaps left"
        }
    }
}

/// "Pick photos" / "Pick videos": the system picker, multi-select up to the
/// pool limit. Picks join the pool and fill the bunch. Ids come from the shared
/// library, so picking the same item twice doesn't add it twice.
struct BunchPicker<PickerLabel: View>: View {
    @ObservedObject var deck: DeckStore
    var kind: MediaKind
    @ViewBuilder var label: () -> PickerLabel

    @State private var picked: [PhotosPickerItem] = []

    var body: some View {
        PhotosPicker(
            selection: $picked,
            maxSelectionCount: DeckState.poolLimit,
            matching: kind == .photo ? .images : .videos,
            preferredItemEncoding: .compatible,
            photoLibrary: .shared(),
            label: label
        )
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await deck.addPicked(items, kind: kind) }
        }
    }
}

// MARK: - Grid or empty state

/// The bunch at an exact size: the grid when dealt, otherwise an empty state of
/// the same size so nothing jumps when it fills.
struct BunchCanvas: View {
    @ObservedObject var deck: DeckStore
    var kind: MediaKind
    var metrics: BunchGridMetrics
    /// "Only the photo picked each round is sent." appears once, under the first step.
    var showsPrivacyNote: Bool
    /// One-column layouts put the call to action at the top of a tall empty
    /// state so it is visible without scrolling; panes centre it.
    var actionsAtTop = false

    var body: some View {
        if deck.bunch(kind).items.isEmpty {
            BunchEmpty(deck: deck, kind: kind, metrics: metrics, showsPrivacyNote: showsPrivacyNote, actionsAtTop: actionsAtTop)
        } else {
            BunchGrid(deck: deck, kind: kind, metrics: metrics)
        }
    }
}

/// Rows of square tiles at the computed size. Missing slots (a short pool) are
/// shown as quiet placeholders.
struct BunchGrid: View {
    @ObservedObject var deck: DeckStore
    var kind: MediaKind
    var metrics: BunchGridMetrics

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var items: [DeckItem] { deck.bunch(kind).items }

    var body: some View {
        VStack(spacing: metrics.gap) {
            ForEach(0..<metrics.rows, id: \.self) { row in
                HStack(spacing: metrics.gap) {
                    ForEach(0..<metrics.columns, id: \.self) { column in
                        slot(row * metrics.columns + column)
                            .frame(width: metrics.tile, height: metrics.tile)
                    }
                }
            }
        }
        .frame(width: metrics.width, height: metrics.height)
        .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .animation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.8), value: items.map(\.id))
        .accessibilityIdentifier("bunch-grid")
    }

    @ViewBuilder private func slot(_ index: Int) -> some View {
        ZStack {
            if index < items.count {
                let item = items[index]
                BunchTile(deck: deck, item: item, index: index, size: metrics.tile)
                    .id(item.id)
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .scale(scale: 0.7).combined(with: .opacity),
                        removal: .opacity
                    ))
            } else if index < DeckState.size(kind) {
                Palette.surface
                    .overlay {
                        Image(systemName: kind == .photo ? "photo" : "video")
                            .font(.system(size: 16, weight: .medium))
                            .foregroundStyle(Palette.text3.opacity(0.6))
                    }
                    .accessibilityHidden(true)
            }
        }
    }
}

/// Same size as the grid: faint tile slots behind one call to action.
struct BunchEmpty: View {
    @ObservedObject var deck: DeckStore
    var kind: MediaKind
    var metrics: BunchGridMetrics
    var showsPrivacyNote: Bool
    var actionsAtTop = false

    private var top: Bool { actionsAtTop && metrics.height > 380 }

    var body: some View {
        ZStack {
            // The bunch's shape, so the empty state reads as "your bunch goes here".
            VStack(spacing: metrics.gap) {
                ForEach(0..<metrics.rows, id: \.self) { _ in
                    HStack(spacing: metrics.gap) {
                        ForEach(0..<metrics.columns, id: \.self) { _ in
                            Palette.surface.opacity(0.55)
                                .frame(width: metrics.tile, height: metrics.tile)
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))

            VStack(spacing: 10) {
                if metrics.height >= 300 {
                    Image(systemName: kind == .photo ? "photo.stack" : "film.stack")
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(Palette.text2)
                        .padding(.bottom, 4)
                }
                Button {
                    Haptics.tick()
                    Task { await deck.deal(kind) }
                } label: {
                    Text(deck.isDealing(kind) ? "Dealing…" : kind == .photo ? "Deal my photos" : "Deal my videos")
                }
                .buttonStyle(.primary)
                .disabled(deck.isDealing(kind))
                .accessibilityIdentifier("deal")

                BunchPicker(deck: deck, kind: kind) {
                    Text(kind == .photo ? "Pick photos" : "Pick videos")
                }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("pick")

                if let note = deck.note(kind) {
                    Text(note)
                        .font(.flCaption)
                        .foregroundStyle(Palette.bad)
                        .multilineTextAlignment(.center)
                } else if showsPrivacyNote {
                    Text("Only the photo picked each round is sent.")
                        .font(.flCaption)
                        .foregroundStyle(Palette.text2)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: 300)
            .padding(.top, top ? 28 : 0)
            .frame(maxHeight: .infinity, alignment: top ? .top : .center)
        }
        .frame(width: metrics.width, height: metrics.height)
    }
}

/// "You have 4 of 6 videos…" when the pool can't fill a bunch, and other notes.
struct BunchNote: View {
    /// Room a wide pane keeps for up to two caption lines.
    static let reservedHeight: CGFloat = 40
    @ObservedObject var deck: DeckStore
    var kind: MediaKind
    var mode: MediaMode

    var body: some View {
        if let have = deck.state.shortfall(kind) {
            let noun = kind == .photo ? "photos" : "videos"
            let other = kind == .photo ? "Videos" : "Photos"
            let hint = mode == .both ? " Pick more or ask the host to switch to \(other)." : " Pick more to play."
            Text("You have \(have) of \(DeckState.size(kind)) \(noun).\(hint)")
                .font(.flCaption)
                .foregroundStyle(Palette.bad)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("bunch-shortfall")
        } else if let note = deck.note(kind), !deck.bunch(kind).items.isEmpty {
            Text(note)
                .font(.flCaption)
                .foregroundStyle(Palette.bad)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Tile

/// Tap = swap (shakes when no swaps are left). Hold = full-screen preview.
/// VoiceOver: activate swaps; the Preview action opens it full screen.
private struct BunchTile: View {
    @ObservedObject var deck: DeckStore
    var item: DeckItem
    var index: Int
    var size: CGFloat

    /// A fresh tile ignores taps this long, so a double tap swaps once, not twice.
    static let settle: TimeInterval = 0.4

    @State private var image: UIImage?
    @State private var shakes: CGFloat = 0
    @State private var appearedAt = Date.distantPast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var swapping: Bool { deck.swapping.contains(item.id) }
    private var swapsLeft: Int { deck.bunch(item.kind).swapsLeft }

    var body: some View {
        ZStack {
            Palette.surface2
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipped()
            } else {
                Image(systemName: item.kind.symbol)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Palette.text3)
            }
            if item.kind == .video {
                HStack(spacing: 3) {
                    Image(systemName: "play.fill").font(.system(size: 9, weight: .bold))
                    if let label = item.durationLabel {
                        Text(label).font(.system(size: 11, weight: .heavy, design: .rounded)).monospacedDigit()
                    }
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(.black.opacity(0.55), in: Capsule())
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .padding(6)
            }
            if swapping {
                Palette.bg.opacity(0.5)
                ProgressView().tint(.white)
            }
        }
        .frame(width: size, height: size)
        .clipped()
        .contentShape(Rectangle())
        .modifier(Shake(animatableData: shakes))
        .onTapGesture(perform: swap)
        .onLongPressGesture(minimumDuration: 0.35) {
            Haptics.lock()
            deck.previewing = item
        }
        .onAppear { appearedAt = Date() }
        .task(id: item.id) {
            image = await deck.thumbnail(for: item, size: CGSize(width: size, height: size))
        }
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(swapping ? "Swapping" : "")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(swapsLeft > 0 ? "Swaps it for another. \(swapsLeft) left." : "No swaps left. Use New bunch.")
        .accessibilityAction { swap() }
        .accessibilityAction(named: "Swap") { swap() }
        .accessibilityAction(named: "Preview") { deck.previewing = item }
    }

    /// "Photo 3 of 12", "Video 2 of 6, 0:06".
    private var accessibilityLabel: String {
        let base = "\(item.kind.label) \(index + 1) of \(DeckState.size(item.kind))"
        return item.durationLabel.map { "\(base), \($0)" } ?? base
    }

    private func swap() {
        guard !swapping, Date().timeIntervalSince(appearedAt) >= Self.settle else { return }
        guard swapsLeft > 0 else {
            Haptics.denied()
            if !reduceMotion { withAnimation(.linear(duration: 0.4)) { shakes += 1 } }
            return
        }
        Haptics.tick()
        Task { await deck.swap(item.id) }
    }
}

/// A small horizontal shake: one full wiggle per unit of `animatableData`.
private struct Shake: GeometryEffect {
    var amount: CGFloat = 6
    var animatableData: CGFloat

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: amount * sin(animatableData * .pi * 4), y: 0))
    }
}

// MARK: - Full preview

/// Full screen: the photo, or the clip looping muted. Tap anywhere to go back.
struct DeckPreview: View {
    var item: DeckItem
    @ObservedObject var deck: DeckStore
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVQueuePlayer?
    @State private var looper: AVPlayerLooper?
    @State private var image: UIImage?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            Group {
                if item.kind == .video, let player {
                    PlayerLayerView(player: player, gravity: .resizeAspect)
                } else if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                } else {
                    ProgressView().tint(Palette.text2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .onTapGesture { dismiss() }

            Button {
                dismiss()
            } label: {
                Label("Close", systemImage: "xmark")
            }
            .buttonStyle(.mediaCircle)
            .padding(16)
            .accessibilityLabel("Close preview")
        }
        .preferredColorScheme(.dark)
        .task { await load() }
        .onDisappear {
            player?.pause()
            looper?.disableLooping()
        }
    }

    private func load() async {
        if item.kind == .photo {
            image = await deck.previewImage(for: item)
        } else if let playerItem = await deck.playerItem(for: item) {
            let player = AVQueuePlayer()
            player.isMuted = true
            looper = AVPlayerLooper(player: player, templateItem: playerItem)
            player.play()
            self.player = player
        }
    }
}
