import AuthenticationServices
import ClerkKit
import SwiftUI

/// Optional sign-in with the shared Yoink Labs Clerk instance, same flows as Split.
/// Guests never need it.
@MainActor final class AccountStore: ObservableObject {
    @Published var userID: String?
    @Published var displayName = ""
    @Published var working = false
    @Published var error: String?
    @Published var awaitingCode = false

    var signedIn: Bool { userID != nil }

    func restore() async {
        for _ in 0..<60 { if Clerk.shared.isLoaded { break }; try? await Task.sleep(for: .milliseconds(100)) }
        applyUser()
    }

    private func applyUser() {
        userID = Clerk.shared.user?.id
        displayName = String((Clerk.shared.user?.firstName ?? Clerk.shared.user?.username ?? "").prefix(Nickname.maxLength))
    }

    /// A fresh Clerk session token, or nil when signed out.
    func token() async -> String? {
        guard signedIn else { return nil }
        return try? await Clerk.shared.auth.getToken()
    }

    func social(apple: Bool) async {
        guard !working else { return }
        working = true; error = nil
        defer { working = false }
        do {
            let result = apple ? try await Clerk.shared.auth.signInWithApple() : try await Clerk.shared.auth.signInWithOAuth(provider: .google)
            let id: String?
            switch result { case .signIn(let flow): id = flow.createdSessionId; case .signUp(let flow): id = flow.createdSessionId }
            if let id { try await Clerk.shared.auth.setActive(sessionId: id) }
            applyUser()
            if userID == nil { error = "Sign-in needs another step. Finish setting up your Yoink Labs account on yoinklabs.dev, or play as a guest." }
        } catch {
            let ns = error as NSError
            let cancelled = (ns.domain == ASAuthorizationError.errorDomain && ns.code == ASAuthorizationError.canceled.rawValue)
                || (ns.domain == ASWebAuthenticationSessionError.errorDomain && ns.code == ASWebAuthenticationSessionError.canceledLogin.rawValue)
            if !cancelled { self.error = error.localizedDescription }
        }
    }

    func sendCode(email: String) async {
        guard !working else { return }
        working = true; error = nil
        defer { working = false }
        do {
            _ = try await Clerk.shared.auth.signInWithEmailCode(emailAddress: email.trimmingCharacters(in: .whitespacesAndNewlines))
            awaitingCode = true
        } catch { self.error = error.localizedDescription }
    }

    func verify(_ code: String) async {
        guard !working else { return }
        working = true; error = nil
        defer { working = false }
        do {
            guard let flow = Clerk.shared.client?.signIn else { error = "Request a new code to continue."; return }
            guard let id = try await flow.verifyCode(code).createdSessionId else {
                error = "There's another account step to finish on yoinklabs.dev. You can play as a guest meanwhile."
                return
            }
            try await Clerk.shared.auth.setActive(sessionId: id)
            applyUser()
            awaitingCode = false
        } catch { self.error = error.localizedDescription }
    }

    func signOut() async {
        do { try await Clerk.shared.auth.signOut(); applyUser() } catch { self.error = error.localizedDescription }
    }
}
