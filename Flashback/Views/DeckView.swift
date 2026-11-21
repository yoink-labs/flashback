import AVKit
import PhotosUI
import SwiftUI
import UIKit

/// "Your deck": an edge-to-edge thumbnail grid you can see, hide, shuffle, and
/// add to. Tap toggles hidden; long-press shows a preview of what could be shown.
struct DeckView: View {
    @ObservedObject var deck: DeckStore
    var mode: MediaMode
    var columns: Int = 3
    /// Horizontal inset for everything except the grid, which runs full width.
    var contentPadding: CGFloat = 0

    @State private var picked: [PhotosPickerItem] = []
    @State private var preview: DeckItem?

    private var shown: Int { deck.counts(mode: mode).total }
    private var fitting: Int { deck.state.fitting(mode).count }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Your deck")
                    .font(.flHeadline)
                    .foregroundStyle(Palette.text)
                Spacer(minLength: 0)
                if !deck.items.isEmpty {
                    Text("\(shown) of \(fitting)")
                        .font(.flCaption)
                        .foregroundStyle(Palette.text2)
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, contentPadding)

            if deck.items.isEmpty {
                emptyDeck
                    .padding(.horizontal, contentPadding)
                Text("Only the photo picked each round is sent.")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text3)
                    .padding(.horizontal, contentPadding)
            } else {
                grid
                HStack(spacing: 10) {
                    shuffleButton(title: deck.isShuffling ? "Shuffling…" : "Shuffle")
                    addButton(title: "Add…")
                }
                .padding(.horizontal, contentPadding)
            }

            if let note = deck.note {
                Text(note)
                    .font(.flCaption)
                    .foregroundStyle(Palette.bad)
                    .padding(.horizontal, contentPadding)
            }
            if MediaLibrary.currentAccess == .limited, !deck.items.isEmpty {
                Button("Choose more photos") {
                    MediaLibrary.manageLimitedSelection()
                }
                .buttonStyle(.text)
                .padding(.horizontal, contentPadding)
            }
        }
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await deck.addPicked(items, mode: mode) }
        }
        .fullScreenCover(item: $preview) { item in
            DeckPreview(item: item, deck: deck)
        }
    }

    // MARK: - Grid

    private var grid: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: Spacing.tileGap), count: columns),
            spacing: Spacing.tileGap
        ) {
            ForEach(deck.items) { item in
                DeckTile(deck: deck, item: item, fits: MediaConstraints.allows(mode, item.kind)) {
                    preview = item
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
    }

    // MARK: - Empty state

    private var emptyDeck: some View {
        EmptyDeck(columns: columns) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(Palette.text3)
            Text("Add photos & videos")
                .font(.fl(17, .semibold))
                .foregroundStyle(Palette.text)
            Button {
                Task { await deck.shuffle(mode: mode) }
                Haptics.tick()
            } label: {
                Text(deck.isShuffling ? "Shuffling…" : "Shuffle from my library")
            }
            .buttonStyle(.primary)
            .disabled(deck.isShuffling)
            .frame(maxWidth: 280)
            .padding(.top, 4)
            PhotosPicker(
                selection: $picked,
                maxSelectionCount: DeckState.size,
                matching: filter,
                preferredItemEncoding: .compatible
            ) {
                Text("Choose…")
            }
            .buttonStyle(.text)
        }
    }

    // MARK: - Buttons

    private func shuffleButton(title: String) -> some View {
        Button {
            Task { await deck.shuffle(mode: mode) }
            Haptics.tick()
        } label: {
            Text(title)
        }
        .buttonStyle(.capsule)
        .disabled(deck.isShuffling)
        .accessibilityIdentifier("shuffle-deck")
    }

    private func addButton(title: String) -> some View {
        PhotosPicker(
            selection: $picked,
            maxSelectionCount: DeckState.size,
            matching: filter,
            preferredItemEncoding: .compatible
        ) {
            Text(title)
        }
        .buttonStyle(.capsule)
        .accessibilityIdentifier("add-media")
    }

    private var filter: PHPickerFilter {
        switch mode {
        case .photos: .images
        case .videos: .videos
        case .both: .any(of: [.images, .videos])
        }
    }
}

// MARK: - Empty deck

/// A dashed area the size of two grid rows, with the two ways to fill it.
private struct EmptyDeck<Content: View>: View {
    var columns: Int
    @ViewBuilder var content: Content

    @State private var width: CGFloat = 0

    private var tile: CGFloat {
        let available = max(0, width - CGFloat(columns - 1) * Spacing.tileGap)
        return available / CGFloat(max(columns, 1))
    }

    var body: some View {
        VStack(spacing: 10) { content }
            .frame(maxWidth: .infinity)
            .frame(minHeight: max(220, tile * 2 + Spacing.tileGap))
            .background {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .strokeBorder(Palette.line, style: StrokeStyle(lineWidth: 1.5, dash: [5, 5]))
            }
            .background {
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { width = proxy.size.width }
                        .onChange(of: proxy.size.width) { _, new in width = new }
                }
            }
    }
}

// MARK: - Tile

private struct DeckTile: View {
    @ObservedObject var deck: DeckStore
    var item: DeckItem
    var fits: Bool
    var onPreview: () -> Void

    @State private var image: UIImage?

    private var hidden: Bool { deck.isHidden(item.id) }

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                ZStack {
                    Palette.surface2

                    Group {
                        if let image {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFill()
                        } else {
                            Image(systemName: item.kind.symbol)
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(Palette.text3)
                        }
                    }
                    .opacity(hidden ? 0.25 : (fits ? 1 : 0.4))

                    if hidden {
                        Image(systemName: "eye.slash.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(Palette.text2)
                    }

                    if !fits && !hidden {
                        Palette.bg.opacity(0.55)
                    }

                    if let label = item.durationLabel {
                        VStack {
                            Spacer()
                            HStack {
                                HStack(spacing: 3) {
                                    Image(systemName: "play.fill").font(.system(size: 8, weight: .bold))
                                    Text(label).font(.system(size: 10, weight: .heavy, design: .rounded))
                                }
                                .foregroundStyle(.white)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(.black.opacity(0.55), in: Capsule())
                                Spacer(minLength: 0)
                            }
                        }
                        .padding(5)
                    }
                }
            }
            .clipped()
            .contentShape(Rectangle())
            .onTapGesture { deck.toggleHidden(item.id) }
            .contextMenu {
                Button {
                    onPreview()
                } label: {
                    Label("Preview", systemImage: "eye")
                }
                Button {
                    deck.toggleHidden(item.id)
                } label: {
                    Label(hidden ? "Show" : "Hide", systemImage: hidden ? "eye" : "eye.slash")
                }
            } preview: {
                DeckPreviewCard(item: item, image: image)
            }
            .task(id: item.id) {
                image = await deck.thumbnail(for: item, size: CGSize(width: 180, height: 180))
            }
            .accessibilityElement()
            .accessibilityLabel(item.kind.label)
            .accessibilityValue(hidden ? "Hidden" : "Shown")
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Double-tap to hide or show this item")
    }
}

/// The quick look shown by a long press, before opening the full preview.
private struct DeckPreviewCard: View {
    var item: DeckItem
    var image: UIImage?

    var body: some View {
        ZStack {
            Palette.surface
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: item.kind.symbol)
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(Palette.text3)
            }
        }
        .frame(width: 300, height: 300)
        .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
    }
}

// MARK: - Full preview

/// Muted playback (or the photo) for one deck item.
private struct DeckPreview: View {
    var item: DeckItem
    @ObservedObject var deck: DeckStore
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var image: UIImage?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Palette.bg.ignoresSafeArea()
            if item.kind == .video {
                if let player {
                    VideoPlayer(player: player)
                        .ignoresSafeArea()
                } else {
                    ProgressView().tint(Palette.text2)
                }
            } else if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                ProgressView().tint(Palette.text2)
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.5), in: Circle())
            }
            .buttonStyle(.plain)
            .padding(16)
            .accessibilityLabel("Close preview")
        }
        .preferredColorScheme(.dark)
        .task { await load() }
        .onDisappear { player?.pause() }
    }

    private func load() async {
        if item.kind == .photo {
            image = await deck.previewImage(for: item)
        } else if let playerItem = await deck.playerItem(for: item) {
            let player = AVPlayer(playerItem: playerItem)
            player.isMuted = true
            player.play()
            self.player = player
        }
    }
}
