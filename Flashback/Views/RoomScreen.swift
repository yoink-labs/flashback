import AVKit
import CoreImage.CIFilterBuiltins
import PhotosUI
import SwiftUI

/// The room. Layout depends only on the available size (folded, open wide, open
/// tall); state, timers, and video playback live in `RoomStore`, so a fold
/// mid-round never loses them.
struct RoomScreen: View {
    @EnvironmentObject private var room: RoomStore

    var body: some View {
        GeometryReader { proxy in
            let layout = RoomLayout.forSize(proxy.size)
            VStack(spacing: 0) {
                if room.connection == .reconnecting || room.connection == .connecting {
                    Label(room.connection == .connecting ? "Connecting…" : "Reconnecting… your place is saved.", systemImage: "wifi.exclamationmark")
                        .font(.footnote).padding(8).frame(maxWidth: .infinity).background(.ultraThinMaterial)
                }
                if let error = room.error {
                    Text(error).font(.footnote.weight(.semibold)).foregroundStyle(.white).padding(10).frame(maxWidth: .infinity)
                        .background(Palette.bad.opacity(0.85)).onTapGesture { room.error = nil }.accessibilityIdentifier("room-error")
                }
                if let view = room.view {
                    content(view, layout: layout)
                } else {
                    ProgressView("Joining room…").frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }

    @ViewBuilder private func content(_ view: RoomView, layout: RoomLayout) -> some View {
        switch view.phase {
        case .lobby: LobbyView(view: view, layout: layout)
        case .countdown: CountdownView(view: view)
        case .reveal: RevealView(view: view, layout: layout, playback: room.playback)
        case .results: ResultsView(view: view)
        case .podium, .closed: PodiumView(view: view)
        }
    }
}

// MARK: - Lobby

struct LobbyView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var layout: RoomLayout
    @State private var picked: [PhotosPickerItem] = []
    @State private var confirmLeave = false

    var body: some View {
        ScrollView {
            Group {
                if layout == .wide {
                    HStack(alignment: .top, spacing: 16) {
                        VStack(spacing: 16) { share; settings }.frame(maxWidth: 340)
                        VStack(spacing: 16) { players; media; leave }
                    }
                } else {
                    VStack(spacing: 16) { share; players; settings; media; leave }
                }
            }
            .padding(16)
            .frame(maxWidth: 1000)
            .frame(maxWidth: .infinity)
        }
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await room.add(picked: items) }
        }
    }

    private var share: some View {
        Card {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("ROOM CODE").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                    Text(view.code).font(.system(size: 38, weight: .black, design: .monospaced)).foregroundStyle(Palette.sun)
                        .accessibilityIdentifier("room-code-display")
                    ShareLink(item: RoomCode.joinURL(view.code), subject: Text("Join my Flashback game"), message: Text("Join my Flashback game with code \(view.code)")) {
                        Label("Share invite", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.bordered)
                }
                Spacer(minLength: 0)
                QRCodeView(text: RoomCode.joinURL(view.code).absoluteString).frame(width: 112, height: 112)
            }
        }
    }

    private var players: some View {
        Card {
            HStack {
                Text("Players").font(.title3.bold())
                Text("\(view.players.count)/\(view.capacity)").foregroundStyle(.secondary)
            }
            let columns = layout == .compact ? [GridItem(.flexible())] : [GridItem(.flexible()), GridItem(.flexible())]
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(view.players) { PlayerRow(player: $0, you: $0.id == view.you.id, lobby: true) }
            }
            Text("Everyone adds at least one photo or video and readies up. The host starts when all players are ready (2 or more).")
                .font(.footnote).foregroundStyle(.secondary)
            HStack {
                Button(view.me?.ready == true ? "Not ready" : "I'm ready") { room.send(.ready(!(view.me?.ready ?? false))) }
                    .buttonStyle(.bordered).controlSize(.large).accessibilityIdentifier("ready")
                if view.isHost {
                    Button("Start game") { room.send(.start) }.buttonStyle(.primary).disabled(view.startBlocker != nil).accessibilityIdentifier("start")
                }
            }
            if let blocker = view.startBlocker { Text(blocker).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private var settings: some View {
        Card {
            Text(view.isHost ? "Settings" : "Settings (set by the host)").font(.title3.bold())
            Stepper("Rounds: \(view.settings.rounds)", value: Binding(get: { view.settings.rounds }, set: { room.send(.settings(rounds: $0)) }), in: 1...20)
                .disabled(!view.isHost)
            Picker("Timer", selection: Binding(get: { view.settings.timerSeconds }, set: { room.send(.settings(timerSeconds: $0)) })) {
                ForEach([10, 15, 20, 30, 45, 60], id: \.self) { Text("\($0) seconds").tag($0) }
            }
            .disabled(!view.isHost)
            Picker("Media", selection: Binding(get: { view.settings.mediaMode }, set: { room.send(.settings(mediaMode: $0)) })) {
                ForEach(MediaMode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .disabled(!view.isHost)
        }
    }

    private var pickerFilter: PHPickerFilter {
        switch view.settings.mediaMode {
        case .photos: .images
        case .videos: .videos
        case .both: .any(of: [.images, .videos])
        }
    }

    private var media: some View {
        Card {
            Text("Your photos and videos").font(.title3.bold())
            Text("Photos are shrunk with location data removed; videos become a 6-second clip. Only the round being played is shown, and everything is deleted when it's done.")
                .font(.footnote).foregroundStyle(.secondary)
            let slots = MediaConstraints.slots(used: view.you.items.count)
            ViewThatFits(in: .horizontal) {
                HStack { randomButton(slots); pickerButton(slots) }
                VStack { randomButton(slots); pickerButton(slots) }
            }
            if MediaLibrary.currentAccess == .limited {
                Button("Choose which photos Flashback can see") { MediaLibrary.manageLimitedSelection() }.font(.footnote)
            }
            ForEach(Array(view.you.items.enumerated()), id: \.element.id) { index, item in
                HStack {
                    Image(systemName: item.kind == .photo ? "photo" : "video")
                    Text(item.kind == .photo ? "Photo \(index + 1)" : "Clip \(index + 1) · \(Int(((item.durationMs ?? 0) / 1000).rounded()))s")
                    Spacer()
                    Button(role: .destructive) { room.send(.removeItem(item.id)) } label: { Image(systemName: "xmark.circle.fill") }
                        .accessibilityLabel("Remove")
                }
            }
            ForEach(room.uploads) { upload in
                Text("\(upload.label): \(upload.state)").font(.footnote).foregroundStyle(upload.failed ? Palette.bad : .secondary)
            }
        }
    }

    private func randomButton(_ slots: Int) -> some View {
        Button { Task { await room.addRandom() } } label: { Label("Pick for me", systemImage: "die.face.5") }
            .buttonStyle(.primary).disabled(slots == 0).accessibilityIdentifier("pick-random")
    }

    private func pickerButton(_ slots: Int) -> some View {
        PhotosPicker(selection: $picked, maxSelectionCount: max(1, slots), matching: pickerFilter, preferredItemEncoding: .compatible) {
            Label("Choose…", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.bordered).disabled(slots == 0)
    }

    private var leave: some View {
        Button("Leave room", role: .destructive) { confirmLeave = true }
            .confirmationDialog("Leave this room? Your photos and videos will be deleted.", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Leave", role: .destructive) { Task { await room.leave() } }
            }
    }
}

struct PlayerRow: View {
    var player: PlayerView
    var you: Bool
    var lobby: Bool
    var body: some View {
        HStack(spacing: 10) {
            Avatar(name: player.nickname)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(player.nickname).font(.headline).lineLimit(1)
                    if you { Text("(you)").font(.caption).foregroundStyle(.secondary) }
                    if player.signedIn { Image(systemName: "checkmark.seal.fill").font(.caption).foregroundStyle(Palette.good).accessibilityLabel("Signed in") }
                }
                HStack(spacing: 6) {
                    if player.isHost { Text("Host").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2).background(Palette.sun, in: Capsule()).foregroundStyle(.black) }
                    if !player.connected { Text("away").font(.caption2).foregroundStyle(.secondary) }
                    if lobby {
                        if player.photos > 0 { Label("\(player.photos)", systemImage: "photo").font(.caption2) }
                        if player.videos > 0 { Label("\(player.videos)", systemImage: "video").font(.caption2) }
                    }
                }
            }
            Spacer(minLength: 0)
            if lobby {
                Text(player.ready ? "Ready" : "Not ready").font(.caption.bold()).foregroundStyle(player.ready ? Palette.good : .secondary)
            } else {
                Text("\(player.score)").font(.headline.monospacedDigit()).foregroundStyle(Palette.sun)
            }
        }
        .padding(10)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
        .opacity(player.connected ? 1 : 0.55)
    }
}

struct QRCodeView: View {
    var text: String
    var body: some View {
        if let image = Self.render(text) {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                .padding(6).background(.white, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("QR code for the join link")
        }
    }

    static func render(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

// MARK: - Countdown

struct CountdownView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.2)) { _ in
            let left = max(1, Int((((view.phaseEndsAt ?? room.serverNow) - room.serverNow) / 1000).rounded(.up)))
            VStack(spacing: 8) {
                Text("ROUND \(view.round?.index ?? 1) OF \(view.round?.total ?? 1)").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                Text("\(left)").font(.system(size: 140, weight: .black, design: .rounded)).foregroundStyle(Palette.sun)
                    .contentTransition(.numericText(countsDown: true))
                    .animation(.snappy, value: left)
                    .sensoryFeedback(.impact(weight: .light), trigger: left)
                Text("Get ready to guess…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Reveal and guess

/// AVPlayerLayer without controls; the player belongs to the store.
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer?
    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        view.backgroundColor = .black
        return view
    }
    func updateUIView(_ view: LayerView, context: Context) { if view.playerLayer.player !== player { view.playerLayer.player = player } }
    static func dismantleUIView(_ view: LayerView, coordinator: ()) { view.playerLayer.player = nil }
}

struct RevealView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var layout: RoomLayout
    /// Owned by the store; observed here only for the mute state.
    @ObservedObject var playback: PlaybackController

    var body: some View {
        Group {
            if layout == .wide {
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 10) { header; stage; timer }
                    ScrollView { guessPanel }.frame(maxWidth: 360)
                }
            } else {
                ScrollView {
                    VStack(spacing: 12) { header; stage.frame(height: layout == .tall ? 460 : 340); timer; guessPanel }
                }
            }
        }
        .padding(16)
    }

    private var round: RoundView { view.round ?? RoundView(index: 1, total: 1) }

    private var header: some View {
        Text("ROUND \(round.index) OF \(round.total)").font(.caption.weight(.bold)).foregroundStyle(.secondary)
    }

    @ViewBuilder private var stage: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 22).fill(.black)
            if round.kind == .video {
                PlayerLayerView(player: playback.player).clipShape(RoundedRectangle(cornerRadius: 22))
                    .overlay(alignment: .bottomTrailing) {
                        Button { playback.muted.toggle() } label: {
                            Label(playback.muted ? "Tap for sound" : "Mute", systemImage: playback.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                                .font(.footnote.bold()).padding(.horizontal, 12).padding(.vertical, 8).background(.black.opacity(0.6), in: Capsule())
                        }
                        .foregroundStyle(.white).padding(12).accessibilityIdentifier("mute")
                    }
            } else if let image = room.revealImage {
                Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 22))
                    .accessibilityLabel("Whose photo is this?")
            }
            if room.revealFailed { Text("Couldn't load this one.").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
            else if (round.kind == .photo && room.revealImage == nil) || (round.kind == .video && playback.player == nil) { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var timer: some View {
        TimelineView(.periodic(from: .now, by: 0.1)) { _ in
            let total = max(1, (round.endsAt ?? 0) - (round.revealAt ?? 0))
            let left = max(0, (round.endsAt ?? room.serverNow) - room.serverNow)
            VStack(spacing: 4) {
                ProgressView(value: left / total).tint(left / total > 0.3 ? Palette.good : Palette.bad)
                HStack {
                    Text("\(Int((left / 1000).rounded(.up)))s left").monospacedDigit()
                    Spacer()
                    if round.canGuess == true && round.yourGuess == nil {
                        let streak = view.me?.streak ?? 0
                        Text("Up to \(Scoring.potential(remainingMs: left, timerMs: total, previousStreak: streak)) points").monospacedDigit()
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var guessPanel: some View {
        Card {
            if round.isYours == true {
                Text("This one's yours 🤫").font(.title3.bold())
                Text("Keep a straight face while the others guess.").foregroundStyle(.secondary)
            } else if round.canGuess == true {
                Text(round.yourGuess.map { "You guessed \(view.name($0))" } ?? "Whose is it?").font(.title3.bold())
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: layout.guessColumns), spacing: 8) {
                    ForEach(view.players.filter { $0.id != view.you.id }) { player in
                        Button { room.send(.guess(player.id)) } label: {
                            Text(player.nickname).font(.headline).lineLimit(2).frame(maxWidth: .infinity, minHeight: 54)
                        }
                        .buttonStyle(.bordered)
                        .tint(round.yourGuess == player.id ? Palette.cool : nil)
                        .disabled(round.yourGuess != nil)
                    }
                }
            } else {
                Text("Watching this round").font(.title3.bold())
            }
            Text("\(round.guessedCount ?? 0)/\(round.guesserCount ?? 0) guessed").font(.footnote).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Results and podium

struct ResultsView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var body: some View {
        ScrollView {
            if let result = view.lastResult {
                Card {
                    Text("ROUND \(result.index) OF \(view.round?.total ?? result.index)").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                    (Text("It was ") + Text(view.name(result.ownerID)).foregroundStyle(Palette.sun) + Text("'s \(result.kind.rawValue)!"))
                        .font(.title.bold())
                    if let mine = result.rows.first(where: { $0.playerID == view.you.id }) {
                        Text(mine.correct ? "Nice! +\(mine.points)" : "Not this time.").font(.headline).foregroundStyle(mine.correct ? Palette.good : Palette.bad)
                    }
                    ForEach(result.rows) { row in
                        HStack {
                            Avatar(name: view.name(row.playerID), size: 28)
                            VStack(alignment: .leading) {
                                Text(view.name(row.playerID)).font(.headline)
                                Text(row.targetID.map { "Guessed \(view.name($0))" } ?? "No guess").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing) {
                                Text("+\(row.points)\(row.streakBonus > 0 ? " 🔥\(row.streak)" : "")").font(.headline.monospacedDigit()).foregroundStyle(row.correct ? Palette.good : .secondary)
                                Text("\(row.total)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if view.isHost {
                        HStack {
                            Button("Next") { room.send(.advance) }.buttonStyle(.primary)
                            Button("End game") { room.send(.end) }.buttonStyle(.bordered)
                        }
                    } else {
                        Text("Next round starts in a moment…").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .padding(16)
                .frame(maxWidth: 680)
                .frame(maxWidth: .infinity)
            }
        }
    }
}

struct PodiumView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    @State private var confirmLeave = false
    private let medals = ["🥇", "🥈", "🥉"]
    var body: some View {
        ScrollView {
            Card {
                Text("Final scores").font(.largeTitle.bold())
                ForEach(view.podium) { entry in
                    HStack(spacing: 12) {
                        Text(entry.rank <= 3 ? medals[entry.rank - 1] : "#\(entry.rank)").font(.title)
                        VStack(alignment: .leading) {
                            Text(view.name(entry.playerID)).font(.headline)
                            Text("\(entry.correctCount) right · best streak \(entry.bestStreak)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text("\(entry.score)").font(.title3.bold().monospacedDigit()).foregroundStyle(Palette.sun)
                    }
                    .padding(10)
                    .background(.white.opacity(entry.rank == 1 ? 0.14 : 0.06), in: RoundedRectangle(cornerRadius: 14))
                }
                Text("All photos and videos from this game have been deleted.").font(.footnote).foregroundStyle(.secondary)
                if view.isHost {
                    Button("Play again") { room.send(.playAgain) }.buttonStyle(.primary).accessibilityIdentifier("play-again")
                } else {
                    Text("Waiting for the host to start another game…").foregroundStyle(.secondary)
                }
                Button("Leave room", role: .destructive) { confirmLeave = true }
                    .confirmationDialog("Leave this room?", isPresented: $confirmLeave, titleVisibility: .visible) {
                        Button("Leave", role: .destructive) { Task { await room.leave() } }
                    }
            }
            .padding(16)
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
        }
    }
}
