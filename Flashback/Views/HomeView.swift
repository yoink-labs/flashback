import SwiftUI

/// Wordmark, one line, your name, and the two doors. The top bar holds the tip
/// pill, About and Sign in at one height; guests need only a name.
struct HomeView: View {
    @EnvironmentObject private var room: RoomStore
    @EnvironmentObject private var account: AccountStore
    @AppStorage("flashback.lastNickname") private var lastName = ""
    @State private var signingIn = false
    @State private var tipping = false
    @State private var showingAbout = false
    @FocusState private var nicknameFocused: Bool

    private var nickname: Result<String, NicknameError> { Nickname.validate(room.draftNickname) }
    private var nicknameValid: Bool {
        if case .success = nickname { return true }
        return false
    }

    var body: some View {
        KeyboardStableLayout { layout, proxy in
            if layout.isWide {
                wide
            } else {
                compact(proxy)
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .modifier(HomeSheets(signingIn: $signingIn, tipping: $tipping, showingAbout: $showingAbout))
        .onAppear {
            if room.draftNickname.isEmpty { room.draftNickname = lastName }
            #if DEBUG
            // Screenshot routes: -uiRoute tipJar | about | join
            switch TipDebugLaunch.value("uiRoute") {
            case "tipJar": tipping = true
            case "about": showingAbout = true
            case "join":
                room.draftCode = "GV82"
                room.showJoin = true
            default: break
            }
            #endif
        }
        .onChange(of: room.draftNickname) { _, value in
            lastName = value
        }
        .onChange(of: account.displayName, initial: true) { _, name in
            if room.draftNickname.isEmpty && !name.isEmpty { room.draftNickname = name }
        }
    }

    /// Inner display / landscape: the hero in the leading pane, the name and the
    /// two doors in the trailing pane (thumb side), nothing in the fold.
    private var wide: some View {
        TwoPane { _ in
            VStack(spacing: 0) {
                HStack {
                    TipTheDevsButton { tipping = true }
                    Spacer(minLength: 0)
                }
                Spacer(minLength: 16)
                hero
                Spacer(minLength: 16)
            }
            .padding(.leading, Spacing.pageWide)
            .padding(.vertical, 12)
        } trailing: { pane in
            ScrollView {
                VStack(spacing: 0) {
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        aboutButton
                        accountButton
                    }
                    Spacer(minLength: 24)
                    actions
                    errorText
                    Spacer(minLength: 24)
                    footer
                }
                .frame(maxWidth: 400)
                .frame(maxWidth: .infinity, minHeight: max(0, pane.height - 24))
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
            .padding(.trailing, Spacing.pageWide)
            .padding(.vertical, 12)
        }
    }

    private func compact(_ proxy: GeometryProxy) -> some View {
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(spacing: 0) {
                        accountRow
                        Spacer(minLength: 20)
                        hero
                        actions
                            .id("actions")
                            .padding(.top, Spacing.section)
                        errorText
                        Spacer(minLength: 24)
                        footer
                    }
                    .padding(.horizontal, Spacing.pageCompact)
                    .padding(.top, 8)
                    .padding(.bottom, 16)
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

    @ViewBuilder private var errorText: some View {
        if let error = room.error {
            Text(error)
                .font(.flCaption)
                .foregroundStyle(Palette.bad)
                .multilineTextAlignment(.center)
                .padding(.top, 12)
                .accessibilityIdentifier("error")
        }
    }

    private var footer: some View {
        Text("Free · no account · nothing is kept")
            .font(.flCaption)
            .foregroundStyle(Palette.text3)
            .multilineTextAlignment(.center)
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

    /// Top bar: "Tip the devs" on the leading side; About and the account on
    /// the trailing side. All three are 36-pt items (44-pt hit areas) on one
    /// centre line, so nothing looks crammed or mismatched.
    private var accountRow: some View {
        HStack(spacing: 8) {
            TipTheDevsButton { tipping = true }
            Spacer(minLength: 8)
            aboutButton
            accountButton
        }
        .frame(height: 44)
    }

    private var aboutButton: some View {
        Button {
            showingAbout = true
        } label: {
            Label("About Flashback", systemImage: "info")
        }
        .buttonStyle(.icon)
        .accessibilityIdentifier("about-button")
    }

    @ViewBuilder private var accountButton: some View {
        if account.signedIn {
            Menu {
                Button("Sign out", role: .destructive) { Task { await account.signOut() } }
            } label: {
                TopBarCapsule(title: account.displayName.isEmpty ? "Account" : account.displayName, symbol: "person.crop.circle.fill")
            }
            .accessibilityLabel("Signed in as \(account.displayName)")
        } else {
            Button {
                signingIn = true
            } label: {
                TopBarCapsule(title: "Sign in", symbol: "person.crop.circle")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sign-in")
        }
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

/// A 36-pt surface capsule with a symbol and a short title, matching the
/// "Tip the devs" pill and the About circle in height.
private struct TopBarCapsule: View {
    var title: String
    var symbol: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
            Text(title)
                .font(.fl(15, .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Palette.text)
        .padding(.horizontal, 14)
        .frame(height: 36)
        .background(Palette.surface, in: Capsule())
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .fixedSize()
    }
}

private struct HomeSheets: ViewModifier {
    @EnvironmentObject private var room: RoomStore
    @EnvironmentObject private var account: AccountStore
    @Binding var signingIn: Bool
    @Binding var tipping: Bool
    @Binding var showingAbout: Bool

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $signingIn) {
                SignInView().environmentObject(account)
            }
            .sheet(isPresented: $tipping) {
                TipJarView(store: .shared)
            }
            .sheet(isPresented: $showingAbout) {
                AboutView()
            }
            .fullScreenCover(isPresented: $room.showJoin) {
                JoinView()
                    .environmentObject(room)
                    .environmentObject(account)
            }
    }
}
