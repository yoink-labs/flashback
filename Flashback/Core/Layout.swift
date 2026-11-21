import CoreGraphics

/// Room layouts for iPhone, iPad, and iPhone Duo poses. Layout is a pure function
/// of the available size; all game state lives in `RoomStore`, so folding or
/// unfolding mid-round never restarts playback, drops a guess, or resets the deck.
enum RoomLayout: Equatable {
    /// Folded cover screen or a regular iPhone in portrait: one column.
    case compact
    /// Open wide (book), iPad landscape, or a phone in landscape: two panes.
    case wide
    /// Open tall or iPad portrait: one roomy column.
    case tall

    static func forSize(_ size: CGSize) -> RoomLayout {
        if size.width >= 640 && size.width > size.height * 1.05 { return .wide }
        if size.width >= 540 { return .tall }
        if size.width > size.height && size.height < 500 { return .wide }
        return .compact
    }

    var isWide: Bool { self == .wide }

    /// Page padding: 20 on phones, 32 on wide layouts.
    var pagePadding: CGFloat { self == .compact ? Spacing.pageCompact : Spacing.pageWide }

    /// Guess grid: four per row on a phone, three in a pane.
    var guessColumns: Int { self == .compact ? 4 : 3 }

    /// Bunch grid columns in the one-column layouts (wide sizes to its pane).
    func bunchColumns(_ kind: MediaKind) -> Int {
        switch (self, kind) {
        case (.tall, .photo): 4
        case (_, .photo): 3
        case (_, .video): 3
        }
    }

    /// Widest the primary column gets on a roomy screen.
    var contentWidth: CGFloat? { self == .compact ? nil : 640 }
}

/// Two panes that meet at the fold. With an iPhone Duo division region (read
/// with `includeInactive`, so nothing moves when the device bends) the gap sits
/// over it; otherwise the width is split in half. Either way the gap is at least
/// `minGap`, so nothing in either pane lands in the curve.
struct PaneSplit: Equatable {
    var leading: CGFloat
    var gap: CGFloat
    var trailing: CGFloat

    /// Kit fold-avoidance band is 27 pt; 32 keeps each pane's edge 16 pt clear.
    static let minGap: CGFloat = 32

    static func make(width: CGFloat, fold: CGRect?, minGap: CGFloat = PaneSplit.minGap) -> PaneSplit {
        let width = max(0, width)
        if let fold, fold.height >= fold.width, fold.midX > width * 0.25, fold.midX < width * 0.75 {
            let start = max(0, min(fold.minX, fold.midX - minGap / 2))
            let end = min(width, max(fold.maxX, fold.midX + minGap / 2))
            return PaneSplit(leading: start, gap: end - start, trailing: width - end)
        }
        let half = max(0, (width - minGap) / 2)
        return PaneSplit(leading: half, gap: minGap, trailing: half)
    }
}

/// Square tiles sized to fill a box: the grid shape that gives the biggest tiles
/// wins (12 → 3×4 or 4×3, 6 → 2×3 or 3×2), so a tall pane gets a tall grid.
struct BunchGridMetrics: Equatable {
    var columns: Int
    var rows: Int
    var tile: CGFloat
    var gap: CGFloat

    var width: CGFloat { CGFloat(columns) * tile + CGFloat(max(0, columns - 1)) * gap }
    var height: CGFloat { CGFloat(rows) * tile + CGFloat(max(0, rows - 1)) * gap }

    static let gap: CGFloat = 4

    /// Fills the width with a fixed column count (the one-column layouts).
    static func filling(width: CGFloat, columns: Int, count: Int, gap: CGFloat = BunchGridMetrics.gap) -> BunchGridMetrics {
        let columns = max(1, columns)
        let rows = max(1, Int((Double(count) / Double(columns)).rounded(.up)))
        let tile = max(0, (width - CGFloat(columns - 1) * gap) / CGFloat(columns))
        return BunchGridMetrics(columns: columns, rows: rows, tile: floor(tile), gap: gap)
    }

    /// Fits inside `width` × `height`, choosing the column count whose square
    /// tiles end up largest. 12 tiles prefer 3×4 or 4×3, 6 prefer 2×3 or 3×2,
    /// and the same rule covers an Even Split bunch of any size (up to 100).
    static func fitting(width: CGFloat, height: CGFloat, count: Int, gap: CGFloat = BunchGridMetrics.gap) -> BunchGridMetrics {
        let count = max(1, count)
        var best = BunchGridMetrics(columns: 1, rows: count, tile: 0, gap: gap)
        for columns in 1...count {
            let rows = (count + columns - 1) / columns
            let byWidth = (width - CGFloat(columns - 1) * gap) / CGFloat(columns)
            let byHeight = (height - CGFloat(rows - 1) * gap) / CGFloat(rows)
            let tile = floor(max(0, min(byWidth, byHeight)))
            if tile > best.tile { best = BunchGridMetrics(columns: columns, rows: rows, tile: tile, gap: gap) }
        }
        return best
    }
}
