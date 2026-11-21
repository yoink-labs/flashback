import SwiftUI

/// Wordmark, one line, your name, and the two doors. Sign-in is a small text
/// button top-right; guests need only a name.
struct HomeView: View {
    @EnvironmentObject private var room: RoomStore
    @EnvironmentObject private var account: AccountStore
    @AppStorage("flashback.lastNickname") private var lastName = ""
    @State private var signingIn = false
    @FocusState private var nicknameFocused: Bool

    private var nickname: Result<String, NicknameError> { Nickname.validate(room.draftNickname) }
    private var nicknameValid: Bool {
        if case .success = nickname { return true }
        return false
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(spacing: 0) {
                        accountRow
                        Spacer(minLength: 20)
                        hero
                        actions
                            .id("actions")
                            .padding(.top, Spacing.section)
                        if let error = room.error {
                            Text(error)
                                .font(.flCaption)
                                .foregroundStyle(Palette.bad)
                                .multilineTextAlignment(.center)
                                .padding(.top, 12)
                                .accessibilityIdentifier("error")
                        }
                        Spacer(minLength: 24)
                        Text("Free · no account · nothing is kept")
                            .font(.flCaption)
                            .foregroundStyle(Palette.text3)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.horizontal, Spacing.pageCompact)
                    .padding(.vertical, 16)
                    .frame(maxWidth: 440)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: nicknameFocused) { _, focused in
                    guard focused else { return }
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(300))
                        withAnimation(.easeOut(duration: 0.25)) {
                            scroller.scrollTo("actions", anchor: .bottom)
                        }
                    }
                }
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .sheet(isPresented: $signingIn) {
            SignInView().environmentObject(account)
        }
        .fullScreenCover(isPresented: $room.showJoin) {
            JoinView()
                .environmentObject(room)
                .environmentObject(account)
        }
        .onAppear {
            if room.draftNickname.isEmpty { room.draftNickname = lastName }
        }
        .onChange(of: room.draftNickname) { _, value in
            lastName = value
        }
        .onChange(of: account.displayName, initial: true) { _, name in
            if room.draftNickname.isEmpty && !name.isEmpty { room.draftNickname = name }
        }
    }

    // MARK: - Pieces

    private var hero: some View {
        VStack(spacing: 20) {
            PolaroidStack()
            VStack(spacing: 6) {
                Text("Flashback")
                    .font(.fl(40, .heavy))
                    .foregroundStyle(Palette.text)
                Text("Whose camera roll is it?")
                    .font(.flBody)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var actions: some View {
        VStack(spacing: 12) {
            TextField("", text: nicknameBinding, prompt: Text("Your name").foregroundStyle(Palette.text3))
                .font(.fl(17, .medium))
                .foregroundStyle(Palette.text)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($nicknameFocused)
                .padding(.horizontal, 16)
                .frame(height: Spacing.row)
                .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
                .accessibilityIdentifier("nickname")

            Button {
                nicknameFocused = false
                Task { await host() }
            } label: {
                Text(room.busy ? "One moment…" : "Host a game")
            }
            .buttonStyle(.primary)
            .disabled(!nicknameValid || room.busy)
            .accessibilityIdentifier("create-room")

            Button {
                nicknameFocused = false
                room.showJoin = true
            } label: {
                Text("Join with code")
            }
            .buttonStyle(.secondary)
            .disabled(!nicknameValid)
            .accessibilityIdentifier("join-room")
        }
    }

    @ViewBuilder private var accountRow: some View {
        HStack {
            Spacer()
            if account.signedIn {
                Menu {
                    Button("Sign out", role: .destructive) { Task { await account.signOut() } }
                } label: {
                    Text(account.displayName.isEmpty ? "Account" : account.displayName)
                        .font(.fl(15, .semibold))
                        .foregroundStyle(Palette.text2)
                        .lineLimit(1)
                }
                .accessibilityLabel("Signed in as \(account.displayName)")
            } else {
                Button("Sign in") { signingIn = true }
                    .buttonStyle(.text)
                    .accessibilityIdentifier("sign-in")
            }
        }
        .frame(height: 44)
    }

    private var nicknameBinding: Binding<String> {
        Binding(
            get: { room.draftNickname },
            set: { room.draftNickname = String($0.prefix(Nickname.maxLength)) }
        )
    }

    private func host() async {
        guard case .success(let name) = nickname else {
            if case .failure(let error) = nickname { room.error = error.localizedDescription }
            return
        }
        await room.create(nickname: name, clerkToken: account.signedIn ? await account.token() : nil)
    }
}
