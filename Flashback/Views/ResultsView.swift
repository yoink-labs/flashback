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
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 24) {
                    if let result {
                        header(result)
                        list(result)
                    } else {
                        ProgressView().tint(Palette.text2).padding(40)
                    }
                }
                .padding(.horizontal, layout.pagePadding)
                .padding(.top, 20)
                .padding(.bottom, 24)
                .frame(maxWidth: layout == .compact ? 560 : 720)
                .frame(maxWidth: .infinity)
            }
            actions
        }
    }

    // MARK: - Header

    private func header(_ result: RoundResult) -> some View {
        let ownerColor = Palette.playerColor(view.colorIndex(result.ownerID))
        let outcome = outcome(result)
        return VStack(spacing: 10) {
            PlayerAvatar(view: view, playerID: result.ownerID, size: 88, ring: Palette.gold)

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

            mediaThumb(result.kind)
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
                .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
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

    @ViewBuilder private func mediaThumb(_ kind: MediaKind) -> some View {
        ZStack {
            Palette.surface2
            if kind == .video, playback.player != nil {
                PlayerLayerView(player: playback.player, gravity: .resizeAspectFill)
            } else if let image = room.revealImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
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
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.tile, style: .continuous))
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

    @ViewBuilder private var actions: some View {
        Group {
            if view.isHost {
                Button {
                    room.send(.advance)
                } label: {
                    Text("Next")
                }
                .buttonStyle(.primary)
                .frame(maxWidth: 360)
                .accessibilityIdentifier("next")
            } else {
                TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                    let left = max(0, (view.phaseEndsAt ?? room.serverNow) - room.serverNow) / 1000
                    Text("Next round in \(Int(left.rounded(.up)))")
                        .font(.flCaption)
                        .foregroundStyle(Palette.text2)
                        .monospacedDigit()
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, layout.pagePadding)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Palette.bg)
    }
}
