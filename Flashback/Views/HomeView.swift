import SwiftUI

/// Create or join a room. Guests need only a nickname; signing in is optional.
struct HomeView: View {
    @EnvironmentObject private var room: RoomStore
    @EnvironmentObject private var account: AccountStore
    @State private var signingIn = false
    @State private var asGuest = false

    private var useAccount: Bool { account.signedIn && !asGuest }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Flashback").font(.system(size: 44, weight: .black, design: .rounded))
                    Text("Whose photo is it? Everyone adds a few photos or short videos, then guesses whose they are.")
                        .foregroundStyle(.secondary)
                }
                Card {
                    Text("Nickname").font(.headline)
                    TextField("What should friends call you?", text: $room.draftNickname)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .padding(12)
                        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityIdentifier("nickname")
                    identity
                }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 16) { createCard; joinCard }
                    VStack(spacing: 16) { createCard; joinCard }
                }
                if let error = room.error { Text(error).foregroundStyle(Palette.bad).accessibilityIdentifier("error") }
                Text("Free and open source by Yoink Labs. Photos and videos are deleted after each round.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(20)
            .frame(maxWidth: 820)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $signingIn) { SignInView() }
        .onChange(of: account.displayName, initial: true) { _, name in
            if room.draftNickname.isEmpty && !name.isEmpty { room.draftNickname = name }
        }
    }

    @ViewBuilder private var identity: some View {
        if useAccount {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(Palette.good)
                Text("Signed in with Yoink Labs").font(.subheadline)
                Spacer()
                Menu("Options") {
                    Button("Play as a guest instead") { asGuest = true }
                    Button("Sign out", role: .destructive) { Task { await account.signOut() } }
                }.font(.subheadline)
            }
        } else {
            HStack(spacing: 6) {
                Text("Playing as a **guest**. No account needed.").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                if account.signedIn { Button("Use my account") { asGuest = false }.font(.subheadline) }
                else { Button("Sign in") { signingIn = true }.font(.subheadline).accessibilityIdentifier("sign-in") }
            }
        }
    }

    private var nickname: Result<String, NicknameError> { Nickname.validate(room.draftNickname) }

    private var createCard: some View {
        Card {
            Text("Host a game").font(.title3.bold())
            Text("Create a room and share the code.").foregroundStyle(.secondary).font(.subheadline)
            Button(room.busy ? "One moment…" : "Create a room") {
                guard case .success(let name) = nickname else { return room.error = nicknameError }
                Task { await room.create(nickname: name, clerkToken: useAccount ? await account.token() : nil) }
            }
            .buttonStyle(.primary)
            .disabled(room.busy)
            .accessibilityIdentifier("create-room")
        }
    }

    private var joinCard: some View {
        Card {
            Text("Join a game").font(.title3.bold())
            TextField("Room code", text: Binding(get: { room.draftCode }, set: { room.draftCode = RoomCode.sanitize($0) }))
                .font(.title2.weight(.heavy).monospaced())
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .padding(10)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("room-code")
            Button("Join room") {
                guard case .success(let name) = nickname else { return room.error = nicknameError }
                guard let code = RoomCode.normalize(room.draftCode) else { return room.error = "Room codes are 6 letters and numbers." }
                Task { await room.join(code: code, nickname: name, clerkToken: useAccount ? await account.token() : nil) }
            }
            .buttonStyle(.primary)
            .disabled(room.busy || RoomCode.normalize(room.draftCode) == nil)
            .accessibilityIdentifier("join-room")
        }
    }

    private var nicknameError: String? {
        if case .failure(let e) = nickname { return e.localizedDescription }
        return nil
    }
}
