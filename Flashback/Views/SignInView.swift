import SwiftUI

/// Optional Yoink Labs sign-in (Apple, Google, or an email code), as in Split.
struct SignInView: View {
    @EnvironmentObject private var account: AccountStore
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var code = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Signing in is optional. It lets you use your Yoink Labs account name across Flashback, Split, and Wanderer.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Section {
                    Button { Task { await account.social(apple: true); if account.signedIn { dismiss() } } } label: { Label("Continue with Apple", systemImage: "apple.logo") }
                    Button { Task { await account.social(apple: false); if account.signedIn { dismiss() } } } label: { Label("Continue with Google", systemImage: "g.circle") }
                }
                Section("Email") {
                    if account.awaitingCode {
                        TextField("6-digit code", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                        Button("Verify") { Task { await account.verify(code); if account.signedIn { dismiss() } } }.disabled(code.count < 6)
                    } else {
                        TextField("you@example.com", text: $email).keyboardType(.emailAddress).textContentType(.emailAddress).textInputAutocapitalization(.never)
                        Button("Email me a code") { Task { await account.sendCode(email: email) } }.disabled(!email.contains("@"))
                    }
                }
                if let error = account.error { Section { Text(error).foregroundStyle(Palette.bad) } }
            }
            .disabled(account.working)
            .navigationTitle("Sign in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Play as guest") { dismiss() } } }
        }
    }
}
