import StoreKit
import StoreKitTest
import XCTest
@testable import Flashback

/// The real StoreKit 2 client against `Flashback.storekit` through
/// StoreKitTest: products load by id, a purchase is verified and finished,
/// cancel/failure/unverified paths, and the storefront gate.
@MainActor
final class StoreKitTipClientTests: XCTestCase {
    private var session: SKTestSession!

    override func setUp() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "Flashback", withExtension: "storekit"))
        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.clearTransactions()
        session.disableDialogs = true
        session.storefront = "USA"
    }

    override func tearDown() async throws {
        session.clearTransactions()
        session = nil
    }

    func testAllSevenTipsLoadByExactID() async throws {
        let products = TipJarStore.ordered(try await StoreKitTipClient().products(for: TipTier.productIDs))
        XCTAssertEqual(products.map(\.tier), TipTier.allCases)
        XCTAssertEqual(products.map(\.price), ["0.99", "2.99", "4.99", "9.99", "19.99", "49.99", "99.99"].map { Decimal(string: $0)! })
    }

    func testPurchaseIsVerifiedAndFinished() async throws {
        let client = StoreKitTipClient()
        _ = try await client.products(for: TipTier.productIDs)

        let result = try await client.purchase(productID: TipTier.xl.productID)

        XCTAssertEqual(result, .success(productID: TipTier.xl.productID))
        XCTAssertEqual(session.allTransactions().count, 1)
        // Finished: nothing left in Transaction.unfinished.
        var unfinished = 0
        for await _ in Transaction.unfinished { unfinished += 1 }
        XCTAssertEqual(unfinished, 0)
    }

    func testStoreShowsThanksAfterARealPurchase() async throws {
        let store = TipJarStore(client: StoreKitTipClient())
        await store.load()
        let product = try XCTUnwrap(store.products.first { $0.tier == .max })

        await store.purchase(product)

        let state = store.purchaseState
        XCTAssertEqual(state, .thanks(.max))
    }

    func testFailedPurchaseSurfacesAnErrorAndNoThanks() async throws {
        try await session.setSimulatedError(.generic(.networkError(URLError(.notConnectedToInternet))), forAPI: .purchase)
        let store = TipJarStore(client: StoreKitTipClient())
        await store.load()
        let product = try XCTUnwrap(store.products.first)

        await store.purchase(product)

        let state = store.purchaseState
        guard case .failed = state else { return XCTFail("Expected failure, got \(state)") }
        XCTAssertTrue(session.allTransactions().isEmpty)
    }

    func testUnverifiedPurchaseGetsNoThanks() async throws {
        try await session.setSimulatedError(.verification(.invalidSignature), forAPI: .verification)
        let store = TipJarStore(client: StoreKitTipClient())
        await store.load()
        let product = try XCTUnwrap(store.products.first)

        await store.purchase(product)

        let state = store.purchaseState
        XCTAssertEqual(state, .failed("The App Store couldn't verify that purchase, so it wasn't completed here."))
    }

    func testStorefrontGate() async throws {
        let client = StoreKitTipClient()
        for (code, shows) in [("USA", true), ("GBR", false), ("BRA", false)] {
            session.storefront = code
            // The test session applies a storefront change asynchronously.
            var current = await client.storefrontCountryCode()
            for _ in 0..<100 where current != code {
                try await Task.sleep(nanoseconds: 50_000_000)
                current = await client.storefrontCountryCode()
            }
            XCTAssertEqual(current, code)
            XCTAssertEqual(TipLinks.allowsExternalTipLink(storefrontCountryCode: current), shows)

            let store = TipJarStore(client: client)
            await store.load()
            let visible = store.showsGiveAnyAmountLink
            XCTAssertEqual(visible, shows, code)
        }
    }
}
