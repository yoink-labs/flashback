import SwiftUI

/// Six code boxes, then the room preview, your name, and Join in the thumb zone.
struct JoinView: View {
    @EnvironmentObject private var room: RoomStore
    @EnvironmentObject private var account: AccountStore
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var code: String { RoomCode.sanitize(room.draftCode) }
    private var complete: Bool { code.count == RoomCode.length }

    private var nicknameValid: Bool {
        if case .success = Nickname.validate(room.draftNickname) { return true }
        return false
    }

    private var canJoin: Bool {
        complete && nicknameValid && !room.busy && room.roomInfo?.joinable == true && room.previewError == nil
    }

    var body: some View {
        NavigationStack {
            KeyboardStableLayout { layout, _ in
                if layout.isWide {
                    wide
                } else {
                    compact
                }
            }
            .background(Palette.bg.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        close()
                    } label: {
                        Label("Back", systemImage: "chevron.left")
                    }
                    .accessibilityIdentifier("join-back")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Palette.bg, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .fontDesign(.rounded)
        .task(id: code) {
            room.error = nil
            guard complete else {
                room.clearPreview()
                return
            }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await room.preview(code: code)
        }
        .onAppear {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                focused = true
            }
        }
    }

    private var compact: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    title
                    codeSection
                    if complete {
                        roomPreview
                            .transition(.opacity)
                        nameField
                    }
                }
                .padding(.horizontal, Spacing.pageCompact)
                .padding(.top, 8)
                .padding(.bottom, 24)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
                .animation(.easeOut(duration: 0.2), value: room.roomInfo)
            }
            .scrollDismissesKeyboard(.interactively)
            if complete {
                joinBar
                    .padding(.horizontal, Spacing.pageCompact)
                    .frame(maxWidth: 520)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    /// Code entry in the leading pane; the room, your name and Join in the
    /// trailing pane, so nothing tappable sits on the fold.
    private var wide: some View {
        TwoPane { _ in
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.section) {
                    title
                    codeSection
                }
                .padding(.top, 8)
            }
            .scrollBounceBehavior(.basedOnSize)
            .padding(.leading, Spacing.pageWide)
        } trailing: { _ in
            VStack(alignment: .leading, spacing: 0) {
                if complete {
                    ScrollView {
                        VStack(alignment: .leading, spacing: Spacing.section) {
                            roomPreview
                            nameField
                        }
                        .padding(.top, 8)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    joinBar
                } else {
                    Text("Ask the host for the 6-letter code.")
                        .font(.flBody)
                        .foregroundStyle(Palette.text3)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .padding(.trailing, Spacing.pageWide)
            .animation(.easeOut(duration: 0.2), value: room.roomInfo)
        }
    }

    private var title: some View {
        Text("Join a game")
            .font(.flTitle)
            .foregroundStyle(Palette.text)
            .accessibilityAddTraits(.isHeader)
    }

    private var codeSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            codeEntry
            if let message = codeMessage {
                Text(message)
                    .font(.flCaption)
                    .foregroundStyle(Palette.bad)
                    .accessibilityIdentifier("join-error")
            }
        }
    }

    // MARK: - Code

    private var codeEntry: some View {
        ZStack {
            HStack(spacing: 8) {
                ForEach(0..<RoomCode.length, id: \.self) { index in
                    codeBox(at: index)
                }
            }
            TextField("", text: codeBinding)
                .keyboardType(.asciiCapable)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .focused($focused)
                // Invisible input behind the boxes: clear text and caret too, since
                // system text effects can draw outside the field's own opacity.
                .foregroundStyle(.clear)
                .tint(.clear)
                .opacity(0.01)
                .accessibilityIdentifier("room-code")
        }
        .frame(maxWidth: 380)
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
    }

    private func codeBox(at index: Int) -> some View {
        let chars = Array(code)
        let filled = index < chars.count
        let active = focused && !complete && index == min(chars.count, RoomCode.length - 1)
        return Text(filled ? String(chars[index]) : "")
            .font(.fl(28, .heavy))
            .foregroundStyle(Palette.text)
            .frame(maxWidth: .infinity, minHeight: 60)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.tile, style: .continuous)
                    .strokeBorder(active ? Palette.accent : Color.clear, lineWidth: 2)
            }
            .accessibilityHidden(true)
    }

    private var codeBinding: Binding<String> {
        Binding(get: { room.draftCode }, set: { room.draftCode = RoomCode.sanitize($0) })
    }

    // MARK: - Preview

    private var codeMessage: String? {
        if let message = room.previewError { return message }
        if room.roomInfo?.joinable == false {
            return room.roomInfo?.phase == "lobby" ? "This room is full" : "This game has already started"
        }
        return room.error
    }

    @ViewBuilder private var roomPreview: some View {
        if let info = room.roomInfo {
            HStack(spacing: 14) {
                Avatar(name: info.host ?? info.code, size: 40, color: Palette.playerColor(0))
                VStack(alignment: .leading, spacing: 3) {
                    Text(info.host.map { "\($0)'s room" } ?? "Room \(info.code)")
                        .font(.flHeadline)
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Text("\(info.players) \(info.players == 1 ? "player" : "players") · \(info.settings?.mediaMode.label ?? "Mix") · \(RoomSettings.roundsLabel(info.rounds))")
                        .font(.flCaption)
                        .foregroundStyle(Palette.text2)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        } else if room.previewLoading {
            HStack(spacing: 10) {
                ProgressView().tint(Palette.text2)
                Text("Looking up the room…")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Name and join

    private var nameField: some View {
        TextField("", text: nicknameBinding, prompt: Text("Your name").foregroundStyle(Palette.text3))
            .font(.fl(17, .medium))
            .foregroundStyle(Palette.text)
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .onSubmit { if canJoin { Task { await join() } } }
            .padding(.horizontal, 16)
            .frame(height: Spacing.row)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .accessibilityIdentifier("join-nickname")
    }

    private var nicknameBinding: Binding<String> {
        Binding(
            get: { room.draftNickname },
            set: { room.draftNickname = String($0.prefix(Nickname.maxLength)) }
        )
    }

    private var joinBar: some View {
        Button {
            Task { await join() }
        } label: {
            Text(room.busy ? "Joining…" : "Join")
        }
        .buttonStyle(.primary)
        .disabled(!canJoin)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Palette.bg)
        .accessibilityIdentifier("join")
    }

    private func join() async {
        guard case .success(let name) = Nickname.validate(room.draftNickname) else {
            if case .failure(let error) = Nickname.validate(room.draftNickname) { room.error = error.localizedDescription }
            return
        }
        guard complete else {
            room.error = "Room codes are 6 letters and numbers."
            return
        }
        let token = account.signedIn ? await account.token() : nil
        await room.join(code: code, nickname: name, clerkToken: token)
        if room.session != nil { close() }
    }

    private func close() {
        room.showJoin = false
        dismiss()
    }
}
