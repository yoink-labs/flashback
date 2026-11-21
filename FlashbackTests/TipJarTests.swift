import StoreKit
import XCTest
@testable import Flashback

/// A scripted StoreKit stand-in.
private final class FakeTipClient: TipStoreClient, @unchecked Sendable {
    var paymentsAllowed = true
    var productsResult: Result<[TipProduct], Error> = .success([])
    var purchaseResult: Result<TipPurchaseResult, Error> = .success(.cancelled)
    private(set) var purchasedIDs: [String] = []
    let updates: AsyncStream<String>
    private let updatesContinuation: AsyncStream<String>.Continuation

    init() {
        (updates, updatesContinuation) = AsyncStream.makeStream(of: String.self)
    }

    func canMakePayments() async -> Bool { paymentsAllowed }

    func products(for ids: [String]) async throws -> [TipProduct] {
        try productsResult.get()
    }

    func purchase(productID: String) async throws -> TipPurchaseResult {
        purchasedIDs.append(productID)
        return try purchaseResult.get()
    }

    func completedTips() -> AsyncStream<String> { updates }

    func deliver(_ productID: String) { updatesContinuation.yield(productID) }
}

private func tip(_ tier: TipTier, price: Decimal, name: String = "") -> TipProduct {
    TipProduct(
        id: tier.productID,
        tier: tier,
        displayName: name,
        description: "",
        displayPrice: "$\(price)",
        price: price
    )
}

@MainActor
final class TipJarStoreTests: XCTestCase {
    func testProductIDsMatchAppStoreConnect() {
        XCTAssertEqual(TipTier.productIDs, [
            "dev.yoinklabs.flashback.tip.small",
            "dev.yoinklabs.flashback.tip.medium",
            "dev.yoinklabs.flashback.tip.large",
        ])
        XCTAssertEqual(TipTier(productID: "dev.yoinklabs.flashback.tip.medium"), .medium)
        XCTAssertNil(TipTier(productID: "dev.yoinklabs.flashback.pro"))
    }

    func testLoadOrdersByStorePriceNotByDeclaration() async {
        let client = FakeTipClient()
        // Storefront pricing could put tiers in any order; cheapest first.
        client.productsResult = .success([
            tip(.large, price: 5),
            tip(.small, price: 1),
            tip(.medium, price: 3),
        ])
        let store = TipJarStore(client: client)

        await store.load()

        XCTAssertEqual(store.loadState, .loaded)
        XCTAssertEqual(store.products.map(\.tier), [.small, .medium, .large])
    }

    func testPricesComeFromTheStore() async {
        let client = FakeTipClient()
        client.productsResult = .success([
            TipProduct(id: TipTier.small.productID, tier: .small, displayName: "Petit pourboire",
                       description: "", displayPrice: "1,09 €", price: 1.09),
        ])
        let store = TipJarStore(client: client)

        await store.load()

        XCTAssertEqual(store.products.first?.displayPrice, "1,09 €")
        XCTAssertEqual(store.products.first?.title, "Petit pourboire")
    }

    func testEmptyDisplayNameFallsBackToTierTitle() {
        XCTAssertEqual(tip(.large, price: 5, name: "  ").title, "Large tip")
    }

    func testNoProductsIsUnavailableNotAnError() async {
        let client = FakeTipClient()
        client.productsResult = .success([])
        let store = TipJarStore(client: client)

        await store.load()

        XCTAssertEqual(store.loadState, .unavailable)
    }

    func testLoadFailureShowsFriendlyMessage() async {
        let client = FakeTipClient()
        client.productsResult = .failure(URLError(.notConnectedToInternet))
        let store = TipJarStore(client: client)

        await store.load()

        XCTAssertEqual(store.loadState, .failed("Couldn't reach the App Store. Check your connection and try again."))
        XCTAssertTrue(store.products.isEmpty)
    }

    func testSuccessfulTipShowsThanks() async {
        let client = FakeTipClient()
        client.purchaseResult = .success(.success(productID: TipTier.medium.productID))
        let store = TipJarStore(client: client)

        await store.purchase(tip(.medium, price: 3))

        XCTAssertEqual(client.purchasedIDs, [TipTier.medium.productID])
        XCTAssertEqual(store.purchaseState, .thanks(.medium))
        XCTAssertEqual(store.thanksCount, 1)

        store.dismissStatus()
        XCTAssertEqual(store.purchaseState, .idle)
    }

    func testCancelReturnsQuietlyToIdle() async {
        let client = FakeTipClient()
        client.purchaseResult = .success(.cancelled)
        let store = TipJarStore(client: client)

        await store.purchase(tip(.small, price: 1))

        XCTAssertEqual(store.purchaseState, .idle)
        XCTAssertEqual(store.thanksCount, 0)
    }

    func testPendingIsReportedAndLaterApprovalThanks() async throws {
        let client = FakeTipClient()
        client.purchaseResult = .success(.pending)
        let store = TipJarStore(client: client)
        store.startObservingTransactions()

        await store.purchase(tip(.large, price: 5))
        XCTAssertEqual(store.purchaseState, .pending)

        // Ask to Buy approved later arrives through Transaction.updates.
        client.deliver(TipTier.large.productID)
        try await waitUntil { store.purchaseState == .thanks(.large) }
        XCTAssertEqual(store.thanksCount, 1)
    }

    func testFailureShowsMessage() async {
        let client = FakeTipClient()
        client.purchaseResult = .failure(TipJarError.unverified)
        let store = TipJarStore(client: client)

        await store.purchase(tip(.small, price: 1))

        XCTAssertEqual(store.purchaseState, .failed("The App Store couldn't verify that purchase, so it wasn't completed here."))
    }

    func testPaymentsDisabledBlocksPurchaseWithoutCallingStoreKit() async {
        let client = FakeTipClient()
        client.paymentsAllowed = false
        client.productsResult = .success([tip(.small, price: 1)])
        let store = TipJarStore(client: client)

        await store.load()
        XCTAssertFalse(store.canMakePayments)
        await store.purchase(tip(.small, price: 1))

        XCTAssertTrue(client.purchasedIDs.isEmpty)
        if case .failed = store.purchaseState {} else {
            XCTFail("Expected a failure, got \(store.purchaseState)")
        }
    }

    func testStoreKitConfigurationListsEveryTierAsConsumable() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Flashback", withExtension: "storekit"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let products = try XCTUnwrap(json["products"] as? [[String: Any]])

        XCTAssertEqual(Set(products.compactMap { $0["productID"] as? String }), Set(TipTier.productIDs))
        XCTAssertTrue(products.allSatisfy { $0["type"] as? String == "Consumable" })
        XCTAssertTrue((json["subscriptionGroups"] as? [Any])?.isEmpty ?? true, "Tips only: no subscriptions")
    }

    func testStoreKitConfigurationMatchesTheSharedTipSpec() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Flashback", withExtension: "storekit"))
        let products = try TipJarConfigClient.products(fromConfig: Data(contentsOf: url))
        let byTier = Dictionary(uniqueKeysWithValues: products.map { ($0.tier, $0) })

        XCTAssertEqual(byTier[.small]?.displayName, "Small tip")
        XCTAssertEqual(byTier[.small]?.description, "A small thank-you to the devs.")
        XCTAssertEqual(byTier[.small]?.price, Decimal(string: "0.99"))
        XCTAssertEqual(byTier[.medium]?.displayName, "Medium tip")
        XCTAssertEqual(byTier[.medium]?.description, "Buys the devs a coffee.")
        XCTAssertEqual(byTier[.medium]?.price, Decimal(string: "2.99"))
        XCTAssertEqual(byTier[.large]?.displayName, "Large tip")
        XCTAssertEqual(byTier[.large]?.description, "A big thank-you to the devs.")
        XCTAssertEqual(byTier[.large]?.price, Decimal(string: "4.99"))
    }

    func testDebugConfigClientReadsPricesFromTheStoreKitFile() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Flashback", withExtension: "storekit"))
        let client = TipJarConfigClient(configURL: url)

        let products = TipJarStore.ordered(try await client.products(for: TipTier.productIDs))

        XCTAssertEqual(products.map(\.tier), [.small, .medium, .large])
        XCTAssertTrue(products.allSatisfy { $0.price > 0 && $0.displayPrice.hasPrefix("$") })
        XCTAssertTrue(products.allSatisfy { !$0.displayName.isEmpty })
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("Timed out waiting for condition") }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }
}
