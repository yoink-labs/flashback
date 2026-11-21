import SwiftUI

/// Optional Yoink Labs sign-in (Apple, Google, or an email code). Guests never
/// need it; this sheet is reached from the small text button on Home.
struct SignInView: View {
    @EnvironmentObject private var account: AccountStore
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var code = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    Text("Sign in")
                        .font(.flTitle)
                        .foregroundStyle(Palette.text)
                    Spacer()
                    Button("Done") { dismiss() }
                        .buttonStyle(.text)
                }

                Text("Optional. Guests can play without it.")
                    .font(.flBody)
                    .foregroundStyle(Palette.text2)

                VStack(spacing: 10) {
                    Button {
                        Task {
                            await account.social(apple: true)
                            if account.signedIn { dismiss() }
                        }
                    } label: {
                        Label("Continue with Apple", systemImage: "apple.logo")
                    }
                    .buttonStyle(.secondary)

                    Button {
                        Task {
                            await account.social(apple: false)
                            if account.signedIn { dismiss() }
                        }
                    } label: {
                        Label("Continue with Google", systemImage: "g.circle")
                    }
                    .buttonStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Email")
                        .font(.flHeadline)
                        .foregroundStyle(Palette.text)

                    if account.awaitingCode {
                        TextField("", text: $code, prompt: Text("6-digit code").foregroundStyle(Palette.text3))
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .signInField()
                        Button("Verify") {
                            Task {
                                await account.verify(code)
                                if account.signedIn { dismiss() }
                            }
                        }
                        .buttonStyle(.primary)
                        .disabled(code.count < 6)
                    } else {
                        TextField("", text: $email, prompt: Text("you@example.com").foregroundStyle(Palette.text3))
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .signInField()
                        Button("Email me a code") {
                            Task { await account.sendCode(email: email) }
                        }
                        .buttonStyle(.secondary)
                        .disabled(!email.contains("@"))
                    }
                }

                if let error = account.error {
                    Text(error)
                        .font(.flCaption)
                        .foregroundStyle(Palette.bad)
                }

                Spacer(minLength: 0)
            }
            .padding(Spacing.pageCompact)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.bg.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .disabled(account.working)
    }
}

private extension View {
    func signInField() -> some View {
        font(.fl(17, .medium))
            .foregroundStyle(Palette.text)
            .padding(.horizontal, 16)
            .frame(height: Spacing.row)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
    }
}
