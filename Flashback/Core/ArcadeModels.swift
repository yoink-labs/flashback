import CoreGraphics
import Foundation

// Milestone 4 (docs/MILESTONE4.md): effects, power-ups, the shop, and the
// server-sized bunch. Every type here decodes with Milestone 3 defaults, so an
// old server (or an old field set) never breaks the app.

// MARK: - Bunch requirement (§2)

/// The room's bunch sizes, from the server's top-level `bunch` view field.
/// Both modes and Even Split are resolved server-side; clients only size their
/// bunches from this. Missing (old servers) means the Milestone 3 constants.
struct BunchRequirement: Codable, Equatable {
    var photos: Int
    var videos: Int

    init(photos: Int = DeckCount.photoBunch, videos: Int = DeckCount.videoBunch) {
        self.photos = max(0, photos)
        self.videos = max(0, videos)
    }

    static let defaults = BunchRequirement()

    func size(_ kind: MediaKind) -> Int { kind == .photo ? photos : videos }

    /// The counts a complete bunch needs in this mode (0 for the kind the mode
    /// doesn't use).
    func required(_ mode: MediaMode) -> DeckCount {
        DeckCount(
            photos: mode == .videos ? 0 : photos,
            videos: mode == .photos ? 0 : videos
        )
    }

    /// Server `deckFits`: every bunch a mode uses is complete.
    func fits(_ counts: DeckCount, mode: MediaMode) -> Bool {
        let need = required(mode)
        return counts.photos >= need.photos && counts.videos >= need.videos
    }

    private enum CodingKeys: String, CodingKey { case photos, videos }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        photos = max(0, (try? c.decodeIfPresent(Int.self, forKey: .photos)) ?? DeckCount.photoBunch)
        videos = max(0, (try? c.decodeIfPresent(Int.self, forKey: .videos)) ?? DeckCount.videoBunch)
    }
}

// MARK: - Effect settings (§1)

enum EffectTrigger: String, Codable, CaseIterable, Identifiable {
    case right, wrong

    var id: String { rawValue }
    var label: String { self == .right ? "Right streak" : "Wrong streak" }
    /// Lobby chip suffix: ↑ right streak, ↓ wrong streak.
    var arrow: String { self == .right ? "↑" : "↓" }
}

enum BlurStrength: String, Codable, CaseIterable, Identifiable {
    case light, medium, heavy

    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    /// Blur radius as a fraction of the media's shorter side (§3).
    var blurFraction: CGFloat {
        switch self {
        case .light: 0.02
        case .medium: 0.04
        case .heavy: 0.07
        }
    }
}

enum EffectFrequency: String, Codable, CaseIterable, Identifiable {
    case every, half

    var id: String { rawValue }
    var label: String { self == .every ? "Every round" : "Half the rounds" }
}

struct GreyscaleSettings: Codable, Equatable {
    var enabled: Bool
    var trigger: EffectTrigger
    var after: Int

    init(enabled: Bool = false, trigger: EffectTrigger = .right, after: Int = 3) {
        self.enabled = enabled
        self.trigger = trigger
        self.after = after
    }

    static let defaults = GreyscaleSettings()

    private enum CodingKeys: String, CodingKey { case enabled, trigger, after }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        trigger = (try? c.decodeIfPresent(EffectTrigger.self, forKey: .trigger)) ?? .right
        after = (try? c.decodeIfPresent(Int.self, forKey: .after)) ?? 3
    }
}

struct BlurSettings: Codable, Equatable {
    var enabled: Bool
    var trigger: EffectTrigger
    var after: Int
    var strength: BlurStrength

    init(enabled: Bool = false, trigger: EffectTrigger = .right, after: Int = 5, strength: BlurStrength = .medium) {
        self.enabled = enabled
        self.trigger = trigger
        self.after = after
        self.strength = strength
    }

    static let defaults = BlurSettings()

    private enum CodingKeys: String, CodingKey { case enabled, trigger, after, strength }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        trigger = (try? c.decodeIfPresent(EffectTrigger.self, forKey: .trigger)) ?? .right
        after = (try? c.decodeIfPresent(Int.self, forKey: .after)) ?? 5
        strength = (try? c.decodeIfPresent(BlurStrength.self, forKey: .strength)) ?? .medium
    }
}

struct FocusSettings: Codable, Equatable {
    var enabled: Bool
    var frequency: EffectFrequency
    /// Percent of the guess timer: 25, 50, 75 or 100.
    var span: Int

    init(enabled: Bool = false, frequency: EffectFrequency = .every, span: Int = 50) {
        self.enabled = enabled
        self.frequency = frequency
        self.span = span
    }

    static let defaults = FocusSettings()

    private enum CodingKeys: String, CodingKey { case enabled, frequency, span }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        frequency = (try? c.decodeIfPresent(EffectFrequency.self, forKey: .frequency)) ?? .every
        span = (try? c.decodeIfPresent(Int.self, forKey: .span)) ?? 50
    }
}

struct ZoomSettings: Codable, Equatable {
    var enabled: Bool
    var frequency: EffectFrequency
    var span: Int
    /// Start scale: 2×, 3× or 4×.
    var scale: Int

    init(enabled: Bool = false, frequency: EffectFrequency = .every, span: Int = 50, scale: Int = 4) {
        self.enabled = enabled
        self.frequency = frequency
        self.span = span
        self.scale = scale
    }

    static let defaults = ZoomSettings()

    private enum CodingKeys: String, CodingKey { case enabled, frequency, span, scale }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        frequency = (try? c.decodeIfPresent(EffectFrequency.self, forKey: .frequency)) ?? .every
        span = (try? c.decodeIfPresent(Int.self, forKey: .span)) ?? 50
        scale = (try? c.decodeIfPresent(Int.self, forKey: .scale)) ?? 4
    }
}

struct EffectsSettings: Codable, Equatable {
    var greyscale: GreyscaleSettings
    var blur: BlurSettings
    var focus: FocusSettings
    var zoom: ZoomSettings

    init(
        greyscale: GreyscaleSettings = .defaults,
        blur: BlurSettings = .defaults,
        focus: FocusSettings = .defaults,
        zoom: ZoomSettings = .defaults
    ) {
        self.greyscale = greyscale
        self.blur = blur
        self.focus = focus
        self.zoom = zoom
    }

    static let defaults = EffectsSettings()

    /// The sheet's allowed choices.
    static let afterRange = 2...10
    static let spans = [25, 50, 75, 100]
    static let scales = [2, 3, 4]

    private enum CodingKeys: String, CodingKey { case greyscale, blur, focus, zoom }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        greyscale = (try? c.decodeIfPresent(GreyscaleSettings.self, forKey: .greyscale)) ?? .defaults
        blur = (try? c.decodeIfPresent(BlurSettings.self, forKey: .blur)) ?? .defaults
        focus = (try? c.decodeIfPresent(FocusSettings.self, forKey: .focus)) ?? .defaults
        zoom = (try? c.decodeIfPresent(ZoomSettings.self, forKey: .zoom)) ?? .defaults
    }

    /// What the client sends as a whole object: ranges clamped and the server's
    /// blur-after-greyscale rule already satisfied, so a valid combination never
    /// trips a 422.
    func validated() -> EffectsSettings {
        var next = self
        next.greyscale.after = min(max(next.greyscale.after, Self.afterRange.lowerBound), Self.afterRange.upperBound)
        next.blur.after = min(max(next.blur.after, Self.afterRange.lowerBound), Self.afterRange.upperBound)
        if !Self.spans.contains(next.focus.span) { next.focus.span = 50 }
        if !Self.spans.contains(next.zoom.span) { next.zoom.span = 50 }
        if !Self.scales.contains(next.zoom.scale) { next.zoom.scale = 4 }
        if next.greyscale.enabled, next.blur.enabled, next.greyscale.trigger == next.blur.trigger,
           next.blur.after <= next.greyscale.after {
            if next.greyscale.after < Self.afterRange.upperBound {
                next.blur.after = next.greyscale.after + 1
            } else {
                next.greyscale.after = Self.afterRange.upperBound - 1
                next.blur.after = Self.afterRange.upperBound
            }
        }
        return next
    }

    /// Whether blur still has to start after greyscale (same trigger): the UI
    /// shows it as a hint, not an error.
    var needsBlurAfterGreyscale: Bool {
        greyscale.enabled && blur.enabled && greyscale.trigger == blur.trigger && blur.after <= greyscale.after
    }
}

// MARK: - Power-up settings (§1, §5, §6)

struct FiftyFiftySettings: Codable, Equatable {
    var enabled: Bool
    /// Earn one charge whenever a correct guess makes the streak a multiple of this.
    var after: Int

    init(enabled: Bool = false, after: Int = 3) {
        self.enabled = enabled
        self.after = after
    }

    static let defaults = FiftyFiftySettings()

    private enum CodingKeys: String, CodingKey { case enabled, after }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        after = (try? c.decodeIfPresent(Int.self, forKey: .after)) ?? 3
    }
}

struct ShopSettings: Codable, Equatable {
    var enabled: Bool

    init(enabled: Bool = false) { self.enabled = enabled }

    static let defaults = ShopSettings()

    private enum CodingKeys: String, CodingKey { case enabled }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
    }
}

struct PowerupSettings: Codable, Equatable {
    var fiftyFifty: FiftyFiftySettings
    var shop: ShopSettings

    init(fiftyFifty: FiftyFiftySettings = .defaults, shop: ShopSettings = .defaults) {
        self.fiftyFifty = fiftyFifty
        self.shop = shop
    }

    static let defaults = PowerupSettings()

    private enum CodingKeys: String, CodingKey { case fiftyFifty, shop }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fiftyFifty = (try? c.decodeIfPresent(FiftyFiftySettings.self, forKey: .fiftyFifty)) ?? .defaults
        shop = (try? c.decodeIfPresent(ShopSettings.self, forKey: .shop)) ?? .defaults
    }

    func validated() -> PowerupSettings {
        var next = self
        next.fiftyFifty.after = min(max(next.fiftyFifty.after, 2), 10)
        return next
    }
}

// MARK: - Per-player items (§6)

/// Public items by a player's avatar and the reveal's power-up bar. Counts are
/// bounded by the contract: 0/1 Double Down, 0/1 Shield, 0/1/2 50/50.
struct PlayerItems: Codable, Equatable {
    var doubleDown: Int
    var shield: Int
    var fiftyFifty: Int

    init(doubleDown: Int = 0, shield: Int = 0, fiftyFifty: Int = 0) {
        self.doubleDown = max(0, doubleDown)
        self.shield = max(0, shield)
        self.fiftyFifty = max(0, fiftyFifty)
    }

    static let none = PlayerItems()

    var hasAny: Bool { doubleDown > 0 || shield > 0 || fiftyFifty > 0 }

    /// The icons shown by avatars, in contract order.
    var icons: [PlayerItemIcon] {
        var icons: [PlayerItemIcon] = []
        if doubleDown > 0 { icons.append(PlayerItemIcon(id: "doubleDown", symbol: ShopItem.doubleDown.symbol, count: doubleDown)) }
        if shield > 0 { icons.append(PlayerItemIcon(id: "shield", symbol: ShopItem.shield.symbol, count: shield)) }
        if fiftyFifty > 0 { icons.append(PlayerItemIcon(id: "fiftyFifty", symbol: ShopItem.fiftyFifty.symbol, count: fiftyFifty)) }
        return icons
    }

    var accessibilityLabel: String {
        var parts: [String] = []
        if doubleDown > 0 { parts.append("Double Down armed") }
        if shield > 0 { parts.append("Shield on") }
        if fiftyFifty > 0 { parts.append("\(fiftyFifty) 50/50") }
        return parts.joined(separator: ", ")
    }

    private enum CodingKeys: String, CodingKey { case doubleDown, shield, fiftyFifty }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        doubleDown = max(0, (try? c.decodeIfPresent(Int.self, forKey: .doubleDown)) ?? 0)
        shield = max(0, (try? c.decodeIfPresent(Int.self, forKey: .shield)) ?? 0)
        fiftyFifty = max(0, (try? c.decodeIfPresent(Int.self, forKey: .fiftyFifty)) ?? 0)
    }
}

struct PlayerItemIcon: Identifiable, Equatable {
    var id: String
    var symbol: String
    var count: Int
}

// MARK: - Round effects (§3, §4)

enum StreakEffectKind: String, Codable {
    case greyscale, blur

    var symbol: String {
        switch self {
        case .greyscale: "circle.lefthalf.filled"
        case .blur: "drop.fill"
        }
    }
}

/// `round.yourEffect` (viewer only): a private streak effect on this reveal.
struct YourEffect: Codable, Equatable {
    var kind: StreakEffectKind
    var strength: BlurStrength?
    var trigger: EffectTrigger
    var streak: Int

    /// "Greyscale · 3 right in a row" / "Blur · 5 wrong in a row".
    var label: String {
        let name = kind == .greyscale ? "Greyscale" : "Blur"
        return "\(name) · \(streak) \(trigger.rawValue) in a row"
    }

    var symbol: String { kind.symbol }

    var blurFraction: CGFloat {
        guard kind == .blur else { return 0 }
        return (strength ?? .medium).blurFraction
    }
}

enum RoundEffectKind: String, Codable {
    case focus, zoom
}

/// `round.effect`: focus or zoom-out, the same for everyone.
struct RoundEffect: Codable, Equatable {
    var kind: RoundEffectKind
    var spanMs: Double
    var scale: Int?
    var originX: Double?
    var originY: Double?

    /// "Focus · guess early for a bonus" / "Zoom-out · guess early for a bonus".
    var label: String {
        kind == .focus ? "Focus · guess early for a bonus" : "Zoom-out · guess early for a bonus"
    }

    var symbol: String {
        kind == .focus ? "scope" : "plus.magnifyingglass"
    }

    /// The zoom anchor as fractions of the media's width and height.
    var origin: CGPoint {
        CGPoint(x: min(max(originX ?? 0.5, 0), 1), y: min(max(originY ?? 0.5, 0), 1))
    }

    private enum CodingKeys: String, CodingKey { case kind, spanMs, scale, originX, originY }

    init(kind: RoundEffectKind, spanMs: Double, scale: Int? = nil, originX: Double? = nil, originY: Double? = nil) {
        self.kind = kind
        self.spanMs = spanMs
        self.scale = scale
        self.originX = originX
        self.originY = originY
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decodeIfPresent(RoundEffectKind.self, forKey: .kind)) ?? .focus
        spanMs = max(0, (try? c.decodeIfPresent(Double.self, forKey: .spanMs)) ?? 0)
        scale = try? c.decodeIfPresent(Int.self, forKey: .scale)
        originX = try? c.decodeIfPresent(Double.self, forKey: .originX)
        originY = try? c.decodeIfPresent(Double.self, forKey: .originY)
    }
}

// MARK: - 50/50 rules (§5)

/// The 50/50 cuts `floor(w / 2)` choices, where `w` is every player except the
/// owner and the viewer. With `w < 2` there is nobody to cut, so the server
/// refuses (409) and keeps the charge.
enum FiftyFiftyRules {
    static func wrongChoices(players: Int, isOwner: Bool) -> Int {
        max(0, players - (isOwner ? 1 : 2))
    }

    static func canCut(players: Int, isOwner: Bool) -> Bool {
        wrongChoices(players: players, isOwner: isOwner) >= 2
    }
}

// MARK: - Results rows (§7)

enum DoubleDownOutcome: String, Codable {
    case won, lost, refunded
}

/// One line of the "you" card's breakdown (§7).
struct BreakdownLine: Identifiable, Equatable {
    enum Tone: Equatable { case good, bad, neutral }

    var id: String { text }
    var text: String
    var tone: Tone
}

enum ResultBreakdown {
    /// The lines shown under the round points, in contract order.
    static func lines(for row: ResultRow) -> [BreakdownLine] {
        var lines: [BreakdownLine] = []
        if row.bonus > 0 {
            lines.append(BreakdownLine(text: "Sharp eyes +\(row.bonus)", tone: .good))
        }
        switch row.doubleDown {
        case .won: lines.append(BreakdownLine(text: "Double Down ×2", tone: .good))
        case .lost: lines.append(BreakdownLine(text: "Double Down −300", tone: .bad))
        case .refunded: lines.append(BreakdownLine(text: "Double Down kept (your photo)", tone: .neutral))
        case nil: break
        }
        if row.shielded {
            lines.append(BreakdownLine(text: "Shield saved your streak", tone: .good))
        }
        if row.earnedFiftyFifty {
            lines.append(BreakdownLine(text: "+1 50/50", tone: .good))
        }
        return lines
    }
}

// MARK: - Shop (§6)

enum ShopItem: String, Codable, CaseIterable, Identifiable {
    case doubleDown, shield, fiftyFifty

    var id: String { rawValue }

    var name: String {
        switch self {
        case .doubleDown: "Double Down"
        case .shield: "Shield"
        case .fiftyFifty: "50/50"
        }
    }

    /// The SF Symbol from §9.
    var symbol: String {
        switch self {
        case .doubleDown: "die.face.5.fill"
        case .shield: "shield.fill"
        case .fiftyFifty: "scissors"
        }
    }

    var caption: String {
        switch self {
        case .doubleDown: "×2 or lose 300"
        case .shield: "Keeps your streak"
        case .fiftyFifty: "Half the wrong picks"
        }
    }

    var defaultPrice: Int {
        switch self {
        case .doubleDown: 250
        case .shield: 200
        case .fiftyFifty: 400
        }
    }

    /// How many a player may hold at once.
    var maxHeld: Int {
        switch self {
        case .doubleDown, .shield: 1
        case .fiftyFifty: 2
        }
    }

    func held(_ items: PlayerItems) -> Int {
        switch self {
        case .doubleDown: items.doubleDown
        case .shield: items.shield
        case .fiftyFifty: items.fiftyFifty
        }
    }
}

struct ShopPrices: Codable, Equatable {
    var doubleDown: Int
    var shield: Int
    var fiftyFifty: Int

    init(doubleDown: Int = 250, shield: Int = 200, fiftyFifty: Int = 400) {
        self.doubleDown = doubleDown
        self.shield = shield
        self.fiftyFifty = fiftyFifty
    }

    static let defaults = ShopPrices()

    func price(_ item: ShopItem) -> Int {
        switch item {
        case .doubleDown: doubleDown
        case .shield: shield
        case .fiftyFifty: fiftyFifty
        }
    }

    private enum CodingKeys: String, CodingKey { case doubleDown, shield, fiftyFifty }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        doubleDown = (try? c.decodeIfPresent(Int.self, forKey: .doubleDown)) ?? 250
        shield = (try? c.decodeIfPresent(Int.self, forKey: .shield)) ?? 200
        fiftyFifty = (try? c.decodeIfPresent(Int.self, forKey: .fiftyFifty)) ?? 400
    }
}

/// `shop` (results, viewer only). The server may put it on the view or on the
/// round; `RoomView.activeShop` reads whichever arrives.
struct ShopView: Codable, Equatable {
    var open: Bool
    var bought: Bool
    var prices: ShopPrices

    init(open: Bool = false, bought: Bool = false, prices: ShopPrices = .defaults) {
        self.open = open
        self.bought = bought
        self.prices = prices
    }

    static let closed = ShopView()

    private enum CodingKeys: String, CodingKey { case open, bought, prices }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        open = (try? c.decodeIfPresent(Bool.self, forKey: .open)) ?? false
        bought = (try? c.decodeIfPresent(Bool.self, forKey: .bought)) ?? false
        prices = (try? c.decodeIfPresent(ShopPrices.self, forKey: .prices)) ?? .defaults
    }
}

/// Why a shop card is (not) tappable. Pure so the rules are unit tested.
enum ShopAvailability: Equatable {
    case available
    case paused
    case bought
    case onePerBreak
    case alreadyHeld
    case notEnoughPoints

    /// The caption under a disabled card, exactly as the contract words it.
    var reason: String? {
        switch self {
        case .available: nil
        case .paused: "Paused"
        case .bought: "Bought ✓"
        case .onePerBreak: "One per break"
        case .alreadyHeld: "You have one"
        case .notEnoughPoints: "Not enough points"
        }
    }

    var isAvailable: Bool { self == .available }

    /// `lastBought` is the item this device just bought in this break, so its
    /// card can say "Bought ✓" while the others say "One per break". Buying is
    /// closed while the host has the game paused.
    static func evaluate(
        item: ShopItem,
        player: PlayerView?,
        shop: ShopView,
        lastBought: ShopItem? = nil,
        paused: Bool = false
    ) -> ShopAvailability {
        if paused { return .paused }
        if shop.bought {
            guard let lastBought else { return .bought }
            return lastBought == item ? .bought : .onePerBreak
        }
        let items = player?.items ?? .none
        if item.held(items) >= item.maxHeld { return .alreadyHeld }
        if (player?.score ?? 0) < shop.prices.price(item) { return .notEnoughPoints }
        return .available
    }
}

// MARK: - Lobby and join-preview chips (§9)

struct SettingsChip: Identifiable, Equatable {
    var id: String
    var label: String
    var symbol: String

    /// Everything enabled, in the contract's order. Nothing enabled means no
    /// chip row at all.
    static func chips(for settings: RoomSettings) -> [SettingsChip] {
        var chips: [SettingsChip] = []
        if settings.evenSplit {
            chips.append(SettingsChip(id: "evenSplit", label: "Even Split", symbol: "equal.circle.fill"))
        }
        let effects = settings.effects
        if effects.greyscale.enabled {
            chips.append(SettingsChip(
                id: "greyscale",
                label: "Greyscale \(effects.greyscale.after)\(effects.greyscale.trigger.arrow)",
                symbol: "circle.lefthalf.filled"
            ))
        }
        if effects.blur.enabled {
            chips.append(SettingsChip(
                id: "blur",
                label: "Blur \(effects.blur.after)\(effects.blur.trigger.arrow)",
                symbol: "drop.fill"
            ))
        }
        if effects.focus.enabled {
            chips.append(SettingsChip(id: "focus", label: "Focus", symbol: "scope"))
        }
        if effects.zoom.enabled {
            chips.append(SettingsChip(id: "zoom", label: "Zoom-out", symbol: "plus.magnifyingglass"))
        }
        if settings.powerups.fiftyFifty.enabled {
            chips.append(SettingsChip(id: "fiftyFifty", label: "50/50", symbol: "scissors"))
        }
        if settings.powerups.shop.enabled {
            chips.append(SettingsChip(id: "shop", label: "Shop", symbol: "cart.fill"))
        }
        return chips
    }
}
