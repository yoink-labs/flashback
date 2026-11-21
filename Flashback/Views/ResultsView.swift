import SwiftUI

/// One list: who owned it, your outcome, then every player's guess, delta, total,
/// and rank movement. The media is a small 96-pt square beside the header.
struct ResultsView: View {
    @EnvironmentObject private var room: RoomStore
    var view: RoomView
    var layout: RoomLayout
    @ObservedObject var playback: PlaybackController

    private var result: RoundResult? { view.lastResult }

    var body: some View {
        if layout.isWide, let result {
            wide(result)
        } else {
            compact
        }
    }

    private var compact: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 20) {
                    if let result {
                        header(result, media: true)
                        youSummary(result)
                        list(result)
                    } else {
                        ProgressView().tint(Palette.text2).padding(40)
                    }
                }
                .padding(.horizontal, layout.pagePadding)
                .padding(.top, 20)
                .padding(.bottom, 24)
                .frame(maxWidth: layout == .compact ? 560 : 640)
                .frame(maxWidth: .infinity)
            }
            actions
                .padding(.horizontal, layout.pagePadding)
                .frame(maxWidth: layout == .compact ? 560 : 640)
                .frame(maxWidth: .infinity)
        }
    }

    /// Owner and the media in the leading pane; your summary, the standings and
    /// Next in the trailing pane.
    private func wide(_ result: RoundResult) -> some View {
        TwoPane { _ in
            VStack(spacing: 16) {
                header(result, media: false)
                wideMedia(result.kind)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .padding(.leading, layout.pagePadding)
            .padding(.vertical, 20)
        } trailing: { _ in
            VStack(spacing: 0) {
                ScrollView {
                    VStack(spacing: 16) {
                        youSummary(result)
                        list(result)
                    }
                    .padding(.vertical, 20)
                }
                .scrollBounceBehavior(.basedOnSize)
                actions
            }
            .padding(.trailing, layout.pagePadding)
        }
    }

    // MARK: - Header

    private func header(_ result: RoundResult, media: Bool) -> some View {
        let ownerColor = Palette.playerColor(view.colorIndex(result.ownerID))
        let outcome = outcome(result)
        return VStack(spacing: 10) {
            PlayerAvatar(view: view, playerID: result.ownerID, size: media ? 88 : 56, ring: Palette.gold)

            (Text("It was ")
                + Text(view.name(result.ownerID)).foregroundStyle(ownerColor)
                + Text("'s"))
                .font(.flTitle)
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)

            if !outcome.text.isEmpty {
                HStack(spacing: 2) {
                    if let points = outcome.points {
                        CountUpText(value: points, prefix: "+")
                    } else {
                        Text(outcome.text)
                    }
                    if let suffix = outcome.suffix {
                        Text(suffix)
                    }
                }
                .font(.flBodyMedium)
                .foregroundStyle(outcome.color)
            }

            if media {
                mediaView(result.kind, fill: true)
                    .frame(width: 140, height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
                    .overlay(alignment: .bottomTrailing) { SaveMediaButton().padding(6) }
                    .padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - You

    /// One line of big numbers with small captions: rank, this round, movement, total.
    @ViewBuilder private func youSummary(_ result: RoundResult) -> some View {
        let standings = Scoring.Standings.rows(players: view.players, result: result)
        if let mine = standings.first(where: { $0.id == view.you.id }) {
            let guess = result.rows.first { $0.playerID == view.you.id }
            let isOwner = result.ownerID == view.you.id
            let points = isOwner ? 0 : (guess?.points ?? 0)
            HStack(alignment: .top, spacing: 0) {
                stat(Self.ordinal(mine.rank), caption: "Rank of \(standings.count)", color: mine.rank == 1 ? Palette.gold : Palette.text)
                stat(points > 0 ? "+\(points)" : "No points", caption: "This round", color: points > 0 ? Palette.good : Palette.text2, small: points == 0)
                stat(movementText(mine.movement), caption: mine.movement == 0 ? "Held" : "Moved", color: mine.movement > 0 ? Palette.good : mine.movement < 0 ? Palette.bad : Palette.text2, small: mine.movement == 0)
                stat(mine.score.formatted(), caption: "Total", color: Palette.text)
            }
            .padding(.vertical, 14)
            .padding(.horizontal, 8)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("you-summary")
        }
    }

    private func movementText(_ movement: Int) -> String {
        movement > 0 ? "▲ \(movement)" : movement < 0 ? "▼ \(-movement)" : "—"
    }

    private func stat(_ value: String, caption: String, color: Color, small: Bool = false) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.fl(small ? 17 : 22, .heavy))
                .monospacedDigit()
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(minHeight: 28)
            Text(caption)
                .font(.flCaption)
                .foregroundStyle(Palette.text3)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }

    static func ordinal(_ n: Int) -> String {
        let tens = n % 100
        let suffix = (11...13).contains(tens) ? "th" : [1: "st", 2: "nd", 3: "rd"][n % 10] ?? "th"
        return "\(n)\(suffix)"
    }

    private struct Outcome {
        var text: String
        var color: Color
        var points: Int? = nil
        var suffix: String? = nil
    }

    private func outcome(_ result: RoundResult) -> Outcome {
        guard let mine = result.rows.first(where: { $0.playerID == view.you.id }) else {
            return Outcome(text: "", color: Palette.text2)
        }
        if mine.playerID == result.ownerID {
            let others = result.rows.filter { $0.playerID != result.ownerID }
            let spotted = others.filter(\.correct).count
            let text = spotted == 0 ? "Yours. Nobody knew 😉"
                : spotted == others.count ? "Yours. Everyone knew"
                : "Yours. \(spotted) of \(others.count) knew"
            return Outcome(text: text, color: Palette.text2)
        }
        if mine.correct {
            let suffix = mine.streak > 1 ? " · \(mine.streak) in a row" : nil
            return Outcome(text: "", color: Palette.good, points: mine.points, suffix: suffix)
        }
        return Outcome(text: "Missed it", color: Palette.text2)
    }

    /// Wide: the photo fits the pane with the save button on the photo itself.
    @ViewBuilder private func wideMedia(_ kind: MediaKind) -> some View {
        if kind == .photo, let image = room.revealImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: Radius.media, style: .continuous))
                .overlay(alignment: .bottomLeading) { SaveMediaButton().padding(12) }
        } else {
            mediaView(kind, fill: false)
                .clipShape(RoundedRectangle(cornerRadius: Radius.media, style: .continuous))
                .overlay(alignment: .bottomLeading) { SaveMediaButton().padding(12) }
        }
    }

    @ViewBuilder private func mediaView(_ kind: MediaKind, fill: Bool) -> some View {
        ZStack {
            fill ? Palette.surface2 : Palette.surface
            if kind == .video, playback.player != nil {
                PlayerLayerView(player: playback.player, gravity: fill ? .resizeAspectFill : .resizeAspect)
            } else if let image = room.revealImage {
                Color.clear.overlay {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: fill ? .fill : .fit)
                }
                .clipped()
            } else {
                Image(systemName: kind.symbol)
                    .font(.title3)
                    .foregroundStyle(Palette.text3)
            }
        }
        .clipped()
    }

    // MARK: - One list

    private struct Row: Identifiable {
        var id: String
        var rank: Int
        var movement: Int
        var score: Int
        var guess: ResultRow?
    }

    private func rows(_ result: RoundResult) -> [Row] {
        let guesses = Dictionary(uniqueKeysWithValues: result.rows.map { ($0.playerID, $0) })
        return Scoring.Standings.rows(players: view.players, result: result).map { standing in
            Row(
                id: standing.id,
                rank: standing.rank,
                movement: standing.movement,
                score: standing.score,
                guess: guesses[standing.id]
            )
        }
    }

    private func list(_ result: RoundResult) -> some View {
        VStack(spacing: 6) {
            ForEach(rows(result)) { row in
                listRow(row, owner: result.ownerID)
            }
        }
    }

    private func listRow(_ row: Row, owner: String) -> some View {
        let isOwner = row.id == owner
        let correct = row.guess?.correct == true
        let isYou = row.id == view.you.id
        return HStack(spacing: 6) {
            Text("\(row.rank)")
                .font(.fl(15, .bold))
                .monospacedDigit()
                .foregroundStyle(row.rank == 1 ? Palette.gold : Palette.text3)
                .frame(width: 18, alignment: .leading)

            PlayerAvatar(view: view, playerID: row.id, size: 40)

            Text(row.id == view.you.id ? "You" : view.name(row.id))
                .font(.fl(17, .semibold))
                .foregroundStyle(Palette.text)
                .lineLimit(1)
                .minimumScaleFactor(0.75)

            Spacer(minLength: 0)

            if isOwner {
                Text("owner")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text3)
                    .frame(width: 40, alignment: .trailing)
                Color.clear.frame(width: 36, height: 1)
            } else {
                target(row, correct: correct)
                Text((row.guess?.points ?? 0) > 0 ? "+\(row.guess?.points ?? 0)" : "")
                    .font(.fl(15, .bold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(Palette.good)
                    .frame(width: 40, alignment: .trailing)
            }

            Text(row.score.formatted())
                .font(.fl(17, .bold))
                .monospacedDigit()
                .minimumScaleFactor(0.8)
                .lineLimit(1)
                .foregroundStyle(Palette.text)
                .frame(width: 56, alignment: .trailing)

            MovementBadge(movement: row.movement)
        }
        .frame(minHeight: Spacing.row)
        .padding(.horizontal, 10)
        .background(isYou ? Palette.surface2 : Palette.surface)
        .overlay(alignment: .leading) {
            if isYou { Rectangle().fill(Palette.accent).frame(width: 3) }
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func target(_ row: Row, correct: Bool) -> some View {
        HStack(spacing: 3) {
            if let targetID = row.guess?.targetID {
                Avatar(
                    name: view.name(targetID),
                    size: 20,
                    color: Palette.playerColor(view.colorIndex(targetID))
                )
            }
            Image(systemName: correct ? "checkmark" : "xmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(correct ? Palette.good : Palette.bad)
        }
        .frame(width: 36, alignment: .trailing)
    }

    // MARK: - Bottom

    /// A thin bar draining to the next round (frozen while paused), then Next
    /// for the host or the countdown caption for guests.
    private var actions: some View {
        VStack(spacing: 10) {
            TimelineView(.periodic(from: .now, by: 0.1)) { _ in
                let total = max(1000, Double(view.settings.breakSeconds) * 1000)
                let left = view.remainingMs(until: view.phaseEndsAt, now: room.serverNow)
                let fraction = min(1, max(0, left / total))
                VStack(spacing: 8) {
                    GeometryReader { bar in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Palette.line)
                            Capsule().fill(Palette.text3)
                                .frame(width: bar.size.width * CGFloat(fraction))
                        }
                    }
                    .frame(height: 3)
                    if !view.isHost {
                        Text(view.paused ? "Paused" : "\(view.isFinalResult ? "Final scores" : "Next round") in \(Int((left / 1000).rounded(.up)))")
                            .font(.flCaption)
                            .foregroundStyle(Palette.text2)
                            .monospacedDigit()
                    }
                }
            }
            .accessibilityIdentifier("next-progress")
            if view.isHost {
                Button {
                    room.send(.advance)
                } label: {
                    Text(view.isFinalResult ? "Final scores" : "Next")
                }
                .buttonStyle(.primary)
                .disabled(view.paused)
                .frame(maxWidth: layout == .compact ? .infinity : 360)
                .accessibilityIdentifier("next")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Palette.bg)
    }
}
