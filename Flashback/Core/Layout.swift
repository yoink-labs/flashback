import CoreGraphics

/// Room layouts for iPhone, iPad, and iPhone Duo poses. Layout is a pure function
/// of the available size; all game state lives in `RoomStore`, so folding or
/// unfolding mid-round only changes arrangement, never state or playback.
enum RoomLayout: Equatable {
    /// Folded cover screen or a regular iPhone in portrait: one column.
    case compact
    /// Open wide (book) or landscape: media and guesses side by side.
    case wide
    /// Open tall or iPad portrait: one roomy column with larger media and a two-column player grid.
    case tall

    static func forSize(_ size: CGSize) -> RoomLayout {
        if size.width >= 640 && size.width > size.height * 1.05 { return .wide }
        if size.width >= 540 { return .tall }
        if size.width > size.height && size.height < 500 { return .wide }
        return .compact
    }

    var guessColumns: Int { self == .compact ? 2 : 3 }
}
