import CoreGraphics

/// Room layouts for iPhone, iPad, and iPhone Duo poses. Layout is a pure function
/// of the available size; all game state lives in `RoomStore`, so folding or
/// unfolding mid-round never restarts playback, drops a guess, or resets the deck.
enum RoomLayout: Equatable {
    /// Folded cover screen or a regular iPhone in portrait: one column.
    case compact
    /// Open wide (book) or landscape: media and guesses side by side.
    case wide
    /// Open tall or iPad portrait: one roomy column with larger media.
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

    /// Guess grid: four per row on a phone, three in the wide right column.
    var guessColumns: Int { self == .compact ? 4 : 3 }

    /// Edge-to-edge deck grid: 3 columns compact, 5 tall, 6 wide.
    var deckColumns: Int {
        switch self {
        case .compact: 3
        case .tall: 5
        case .wide: 6
        }
    }

    /// Widest the primary column gets on a roomy screen.
    var contentWidth: CGFloat? { self == .compact ? nil : 640 }
}
