import Foundation
import StoreKit

/// The optional tip jar. Flashback is free with nothing locked; a tip is a
/// consumable in-app purchase that unlocks nothing and can be repeated.
///
/// Product ids match the consumables in App Store Connect and
/// `Flashback.storekit`. Prices always come from StoreKit, never from code.
/// Ported from Wanderer's tip jar (same org, same shared spec).
enum TipTier: String, CaseIterable, Identifiable, Sendable {
    case small
    case medium
    case large
    case xl
    case xxl
    case huge
    case max

    var id: String { rawValue }

    var productID: String { "dev.yoinklabs.flashback.tip.\(rawValue)" }

    init?(productID: String) {
        guard let tier = Self.allCases.first(where: { $0.productID == productID }) else { return nil }
        self = tier
    }

    static var productIDs: [String] { allCases.map(\.productID) }

    /// Used only if StoreKit returns an empty display name.
    var fallbackTitle: String {
        switch self {
        case .small: return "Small tip"
        case .medium: return "Medium tip"
        case .large: return "Large tip"
        case .xl: return "Extra-large tip"
        case .xxl: return "Generous tip"
        case .huge: return "Huge tip"
        case .max: return "Biggest tip"
        }
    }

    var symbol: String {
        switch self {
        case .small: return "hand.thumbsup.fill"
        case .medium: return "cup.and.saucer.fill"
        case .large: return "heart.fill"
        case .xl: return "fork.knife"
        case .xxl: return "gift.fill"
        case .huge: return "star.fill"
        case .max: return "sparkles"
        }
    }
}

/// A tip as StoreKit described it. A plain value so the store and its tests
/// don't depend on `StoreKit.Product`, which can't be constructed by hand.
struct TipProduct: Identifiable, Equatable, Sendable {
    let id: String
    let tier: TipTier
    let displayName: String
    let description: String
    /// Localized by the App Store for the user's storefront.
    let displayPrice: String
    let price: Decimal

    var title: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? tier.fallbackTitle : trimmed
    }
}

enum TipPurchaseResult: Equatable, Sendable {
    /// Paid, verified and finished.
    case success(productID: String)
    /// Waiting on Ask to Buy or Strong Customer Authentication.
    case pending
    /// The person backed out of the payment sheet.
    case cancelled
}

enum TipJarError: Error, Equatable {
    case paymentsDisabled
    case productUnavailable
    case unverified
    case network
    case other(String)
}

/// The slice of StoreKit the tip jar uses, so the store can be tested
/// without the App Store.
protocol TipStoreClient: Sendable {
    func canMakePayments() async -> Bool
    func products(for ids: [String]) async throws -> [TipProduct]
    func purchase(productID: String) async throws -> TipPurchaseResult
    /// Tips completed outside a `purchase` call: an approved Ask to Buy, or a
    /// transaction left unfinished by a previous launch. Each is finished
    /// before it's yielded.
    func completedTips() -> AsyncStream<String>
    /// ISO 3166-1 alpha-3 code of the App Store storefront, or nil if unknown.
    func storefrontCountryCode() async -> String?
}

/// Where "Give any amount" points. Opened in Safari, never in the app.
enum TipLinks {
    static let giveAnyAmount = URL(string: "https://yoinklabs.dev/tip")!

    /// App Review Guideline 3.1.1(a)/3.1.3: a link to another way to pay is
    /// allowed without an entitlement only on the United States storefront.
    /// Unknown storefront means no link.
    static func allowsExternalTipLink(storefrontCountryCode code: String?) -> Bool {
        code == "USA"
    }
}

/// StoreKit 2, no third-party SDK.
struct StoreKitTipClient: TipStoreClient {
    /// The `Product`s from the last load, so a tap buys exactly what the
    /// row showed without another App Store round trip.
    private let cache = ProductCache()
    /// Transactions already finished and reported, so one delivered through
    /// both `Transaction.updates` and `Transaction.unfinished` thanks once.
    private let ledger = FinishedLedger()

    func canMakePayments() async -> Bool {
        AppStore.canMakePayments
    }

    func storefrontCountryCode() async -> String? {
        await Storefront.current?.countryCode
    }

    func products(for ids: [String]) async throws -> [TipProduct] {
        do {
            let loaded = try await Product.products(for: ids)
            await cache.store(loaded)
            return loaded.compactMap { product in
                guard let tier = TipTier(productID: product.id) else { return nil }
                return TipProduct(
                    id: product.id,
                    tier: tier,
                    displayName: product.displayName,
                    description: product.description,
                    displayPrice: product.displayPrice,
                    price: product.price
                )
            }
        } catch {
            throw Self.map(error)
        }
    }

    func purchase(productID: String) async throws -> TipPurchaseResult {
        let product: Product
        if let cached = await cache.product(for: productID) {
            product = cached
        } else {
            do {
                guard let found = try await Product.products(for: [productID]).first else {
                    throw TipJarError.productUnavailable
                }
                product = found
            } catch {
                throw Self.map(error)
            }
        }

        let result: Product.PurchaseResult
        do {
            result = try await product.purchase()
        } catch StoreKitError.userCancelled {
            return .cancelled
        } catch {
            throw Self.map(error)
        }

        switch result {
        case .success(let verification):
            guard case .verified(let transaction) = verification else {
                // No thank-you for a purchase we can't verify. A tip grants
                // nothing, so finish it anyway; left unfinished it would be
                // re-delivered at every launch.
                await verification.unsafePayloadValue.finish()
                throw TipJarError.unverified
            }
            await transaction.finish()
            await ledger.markFinished(transaction.id)
            return .success(productID: transaction.productID)
        case .pending:
            return .pending
        case .userCancelled:
            return .cancelled
        @unknown default:
            throw TipJarError.other("The App Store returned an unexpected result.")
        }
    }

    func completedTips() -> AsyncStream<String> {
        AsyncStream { continuation in
            let task = Task.detached {
                await withTaskGroup(of: Void.self) { group in
                    // Listen for updates first so nothing slips past while the
                    // unfinished backlog drains.
                    group.addTask {
                        for await verification in Transaction.updates {
                            if let id = await finishIfTip(verification) { continuation.yield(id) }
                        }
                    }
                    group.addTask {
                        for await verification in Transaction.unfinished {
                            if let id = await finishIfTip(verification) { continuation.yield(id) }
                        }
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Finishes any tip transaction (verified or not, since a tip grants
    /// nothing) and returns its product id only if it's verified, not
    /// refunded, and not already reported.
    private func finishIfTip(_ verification: VerificationResult<Transaction>) async -> String? {
        let transaction = verification.unsafePayloadValue
        guard TipTier(productID: transaction.productID) != nil else { return nil }
        await transaction.finish()
        guard case .verified = verification, transaction.revocationDate == nil,
              await ledger.markFinished(transaction.id) else { return nil }
        return transaction.productID
    }

    static func map(_ error: Error) -> Error {
        if let tipError = error as? TipJarError { return tipError }
        if let storeError = error as? StoreKitError {
            switch storeError {
            case .networkError: return TipJarError.network
            case .notAvailableInStorefront: return TipJarError.productUnavailable
            default: break
            }
        }
        if let purchaseError = error as? Product.PurchaseError {
            switch purchaseError {
            case .purchaseNotAllowed: return TipJarError.paymentsDisabled
            case .productUnavailable: return TipJarError.productUnavailable
            default: break
            }
        }
        if error is URLError { return TipJarError.network }
        return TipJarError.other(error.localizedDescription)
    }
}

private actor ProductCache {
    private var products: [String: Product] = [:]
    func store(_ loaded: [Product]) { for product in loaded { products[product.id] = product } }
    func product(for id: String) -> Product? { products[id] }
}

private actor FinishedLedger {
    private var ids: Set<UInt64> = []
    /// True the first time an id is seen.
    @discardableResult func markFinished(_ id: UInt64) -> Bool { ids.insert(id).inserted }
}

@MainActor
final class TipJarStore: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        /// The App Store returned none of our products (not yet created in
        /// App Store Connect, or not offered in this storefront).
        case unavailable
        case failed(String)
    }

    enum PurchaseState: Equatable {
        case idle
        case purchasing(TipTier)
        case pending
        case thanks(TipTier)
        case failed(String)
    }

    /// One store for the app, so an Ask to Buy approved later still lands.
    static let shared: TipJarStore = {
        #if DEBUG
        if let configClient = TipJarConfigClient.fromLaunchArguments() {
            return TipJarStore(client: configClient)
        }
        #endif
        return TipJarStore(client: StoreKitTipClient())
    }()

    @Published private(set) var products: [TipProduct] = []
    @Published private(set) var loadState: LoadState = .idle
    @Published private(set) var purchaseState: PurchaseState = .idle
    @Published private(set) var canMakePayments = true
    /// "Give any amount" (a link out to yoinklabs.dev) shows only on the US
    /// storefront. See `TipLinks.allowsExternalTipLink`.
    @Published private(set) var showsGiveAnyAmountLink = false
    /// Bumps on every completed tip; drives the success haptic.
    @Published private(set) var thanksCount = 0

    private let client: TipStoreClient
    private var observer: Task<Void, Never>?

    init(client: TipStoreClient) {
        self.client = client
    }

    var isPurchasing: Bool {
        if case .purchasing = purchaseState { return true }
        return false
    }

    func load() async {
        if loadState == .loading { return }
        loadState = .loading
        canMakePayments = await client.canMakePayments()
        await refreshStorefront()
        do {
            let found = try await client.products(for: TipTier.productIDs)
            products = Self.ordered(found)
            loadState = products.isEmpty ? .unavailable : .loaded
        } catch {
            products = []
            loadState = .failed(Self.message(for: error))
        }
    }

    /// Rechecks the storefront (it can change while the app runs) without
    /// reloading products.
    func refreshStorefront() async {
        showsGiveAnyAmountLink = TipLinks.allowsExternalTipLink(
            storefrontCountryCode: await client.storefrontCountryCode()
        )
    }

    func purchase(_ product: TipProduct) async {
        guard !isPurchasing else { return }
        guard canMakePayments else {
            purchaseState = .failed(Self.message(for: TipJarError.paymentsDisabled))
            return
        }
        purchaseState = .purchasing(product.tier)
        do {
            switch try await client.purchase(productID: product.id) {
            case .success(let productID):
                showThanks(for: productID)
            case .pending:
                purchaseState = .pending
            case .cancelled:
                purchaseState = .idle
            }
        } catch {
            purchaseState = .failed(Self.message(for: error))
        }
    }

    func dismissStatus() {
        guard !isPurchasing else { return }
        purchaseState = .idle
    }

    /// Finishes tips StoreKit delivers outside the purchase flow. Call once
    /// at launch.
    func startObservingTransactions() {
        guard observer == nil else { return }
        let stream = client.completedTips()
        observer = Task { [weak self] in
            for await productID in stream {
                self?.showThanks(for: productID)
            }
        }
    }

    private func showThanks(for productID: String) {
        purchaseState = .thanks(TipTier(productID: productID) ?? .small)
        thanksCount += 1
    }

    nonisolated static func ordered(_ products: [TipProduct]) -> [TipProduct] {
        products.sorted { lhs, rhs in
            if lhs.price != rhs.price { return lhs.price < rhs.price }
            return lhs.tier.sortIndex < rhs.tier.sortIndex
        }
    }

    nonisolated static func message(for error: Error) -> String {
        switch StoreKitTipClient.map(error) as? TipJarError {
        case .paymentsDisabled:
            return "In-app purchases are turned off on this device. You can allow them in Screen Time settings."
        case .productUnavailable:
            return "That tip isn't available in your App Store region right now."
        case .unverified:
            return "The App Store couldn't verify that purchase, so it wasn't completed here."
        case .network:
            return "Couldn't reach the App Store. Check your connection and try again."
        case .other(let detail):
            return detail.isEmpty ? "Something went wrong with the App Store. Please try again." : detail
        case nil:
            return "Something went wrong with the App Store. Please try again."
        }
    }
}

private extension TipTier {
    var sortIndex: Int { Self.allCases.firstIndex(of: self) ?? 0 }
}
