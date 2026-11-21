#if DEBUG
import SwiftUI
import UIKit

/// Screenshot fixtures: `-uiRoute <name>` renders a room screen with sample
/// players and a generated bunch, with no server and no photo library.
///
/// Routes: lobby, lobbyMix, lobbyVideos, lobbyEmpty, lobbyGuest, settings,
/// countdown, shuffling, reveal, revealLocked, revealPaused, pausedGuest,
/// results, resultsOwner, resultsSaveDenied, podium.
@MainActor enum DebugFixtures {
    static func apply(to room: RoomStore) {
        guard let route = TipDebugLaunch.value("uiRoute") else { return }
        let now = Date().timeIntervalSince1970 * 1000
        switch route {
        case "lobby", "settings":
            room.debugLoad(lobby(now: now, mode: .photos, host: true))
            fill(room.deck, photos: 12, videos: 0)
        case "lobbyMix":
            room.debugLoad(lobby(now: now, mode: .both, host: true))
            fill(room.deck, photos: 12, videos: 0)
        case "lobbyVideos":
            room.debugLoad(lobby(now: now, mode: .both, host: true))
            fill(room.deck, photos: 12, videos: 6)
            room.deck.step = .video
        case "lobbyEmpty":
            room.debugLoad(lobby(now: now, mode: .photos, host: true, blocker: "Deal 12 photos"))
        case "lobbyGuest":
            var view = lobby(now: now, mode: .photos, host: false, blocker: "Waiting for Robo")
            view.players[1].ready = true
            room.debugLoad(view)
            fill(room.deck, photos: 12, videos: 0, swapsLeft: 0)
        case "countdown":
            var view = base(now: now, phase: .countdown)
            view.phaseEndsAt = now + 2400
            view.round = RoundView(index: 3, total: 10, waiting: false)
            room.debugLoad(view)
        case "shuffling":
            var view = base(now: now, phase: .countdown)
            view.round = RoundView(index: 3, total: 10, waiting: true)
            room.debugLoad(view)
        case "reveal", "revealLocked", "revealPaused", "pausedGuest":
            var view = reveal(now: now, locked: route == "revealLocked")
            if route == "revealPaused" || route == "pausedGuest" {
                view.paused = true
                view.pausedRemainingMs = 12_000
            }
            if route == "pausedGuest" { view.you = YouView(id: "p2") }
            room.debugLoad(view, media: MediaBlob(kind: .photo, bytes: photo(index: 4, size: CGSize(width: 1200, height: 900))))
        case "results", "resultsOwner", "resultsSaveDenied":
            let media = MediaBlob(kind: .photo, bytes: photo(index: 4, size: CGSize(width: 1200, height: 900)))
            room.debugLoad(reveal(now: now, locked: true), media: media)
            room.apply(results(now: now, owner: route == "resultsOwner"))
            if route == "resultsSaveDenied" {
                room.show(Toast(text: MediaSaver.SaveError.denied.localizedDescription, symbol: "exclamationmark.triangle.fill", isError: true, action: .openSettings))
            }
        case "podium":
            var view = base(now: now, phase: .podium)
            view.players[0].score = 2140
            view.players[1].score = 2610
            view.players[2].score = 1380
            view.players[3].score = 640
            view.podium = [
                PodiumEntry(playerID: "p2", rank: 1, score: 2610, bestStreak: 4, correctCount: 7),
                PodiumEntry(playerID: "p1", rank: 2, score: 2140, bestStreak: 3, correctCount: 6),
                PodiumEntry(playerID: "p3", rank: 3, score: 1380, bestStreak: 2, correctCount: 4),
                PodiumEntry(playerID: "p4", rank: 4, score: 640, bestStreak: 1, correctCount: 2),
            ]
            room.debugLoad(view)
        default:
            break
        }
    }

    // MARK: - Views

    private static func base(now: Double, phase: Phase) -> RoomView {
        RoomView(
            code: "GV82W5",
            phase: phase,
            game: 1,
            hostID: "p1",
            capacity: 12,
            settings: RoomSettings(rounds: 10, timerSeconds: 20, mediaMode: .both, breakSeconds: 7, swaps: 3),
            serverNow: now,
            phaseEndsAt: nil,
            startBlocker: nil,
            players: [
                PlayerView(id: "p1", nickname: "Sam", isHost: true, ready: true, score: 1240, deck: DeckCount(photos: 12, videos: 6)),
                PlayerView(id: "p2", nickname: "Robo", ready: true, score: 1610, deck: DeckCount(photos: 12, videos: 6)),
                PlayerView(id: "p3", nickname: "Uma", ready: true, score: 880, deck: DeckCount(photos: 12, videos: 6)),
                PlayerView(id: "p4", nickname: "Theo", ready: true, connected: true, score: 410, deck: DeckCount(photos: 12, videos: 6)),
            ],
            you: YouView(id: "p1"),
            round: nil,
            lastResult: nil,
            podium: []
        )
    }

    private static func lobby(now: Double, mode: MediaMode, host: Bool, blocker: String? = "Waiting for Robo") -> RoomView {
        var view = base(now: now, phase: .lobby)
        view.settings.mediaMode = mode
        view.players = Array(view.players.prefix(3)).map { var p = $0; p.score = 0; p.ready = false; return p }
        view.players[2].ready = true
        view.startBlocker = blocker
        if !host { view.you = YouView(id: "p3") }
        return view
    }

    private static func reveal(now: Double, locked: Bool) -> RoomView {
        var view = base(now: now, phase: .reveal)
        view.phaseEndsAt = now + 13_000
        view.round = RoundView(index: 3, total: 10, kind: .photo, revealAt: now - 7000, endsAt: now + 13_000, canGuess: !locked, yourGuess: locked ? "p2" : nil, guessedCount: locked ? 2 : 1, guesserCount: 4)
        return view
    }

    private static func results(now: Double, owner: Bool) -> RoomView {
        var view = base(now: now, phase: .results)
        view.phaseEndsAt = now + 5200
        view.round = RoundView(index: 3, total: 10)
        let ownerID = owner ? "p1" : "p2"
        let rows = [
            ResultRow(playerID: "p1", targetID: "p2", correct: !owner, points: owner ? 0 : 640, accuracy: 500, speed: 140, streakBonus: 0, streak: owner ? 0 : 2, elapsedMs: 4200, total: owner ? 1240 : 1880),
            ResultRow(playerID: "p2", targetID: "p3", correct: owner ? false : false, points: 0, accuracy: 0, speed: 0, streakBonus: 0, streak: 0, elapsedMs: 6000, total: 1610),
            ResultRow(playerID: "p3", targetID: ownerID, correct: true, points: 720, accuracy: 500, speed: 220, streakBonus: 0, streak: 1, elapsedMs: 3100, total: 1600),
            ResultRow(playerID: "p4", targetID: "p1", correct: owner, points: owner ? 410 : 0, accuracy: 0, speed: 0, streakBonus: 0, streak: 0, elapsedMs: 9000, total: owner ? 820 : 410),
        ]
        for row in rows {
            if let index = view.players.firstIndex(where: { $0.id == row.playerID }) { view.players[index].score = row.total }
        }
        view.lastResult = RoundResult(index: 3, ownerID: ownerID, kind: .photo, rows: rows)
        return view
    }

    // MARK: - Generated media

    private static func fill(_ deck: DeckStore, photos: Int, videos: Int, swapsLeft: Int? = nil) {
        let photoItems = (0..<photos).map { index in
            DeckItem(id: "fixture-photo-\(index)", kind: .photo, assetID: nil, photoData: photo(index: index, size: CGSize(width: 360, height: 360)), videoFile: nil, duration: nil, origin: .picked)
        }
        let videoItems = (0..<videos).map { index in
            DeckItem(id: "fixture-video-\(index)", kind: .video, assetID: nil, photoData: photo(index: index + 20, size: CGSize(width: 360, height: 360)), videoFile: nil, duration: Double(4 + index % 5), origin: .picked)
        }
        deck.debugFill(photos: photoItems, videos: videoItems, swapsLeft: swapsLeft)
    }

    /// A soft two-colour "photo" with a sun and hills, so tiles read as pictures.
    static func photo(index: Int, size: CGSize) -> Data {
        let palette: [(UIColor, UIColor)] = [
            (.systemOrange, .systemPink), (.systemTeal, .systemBlue), (.systemYellow, .systemOrange),
            (.systemMint, .systemGreen), (.systemPurple, .systemIndigo), (.systemRed, .systemOrange),
            (.systemCyan, .systemTeal), (.systemPink, .systemPurple), (.systemGreen, .systemTeal),
            (.systemBlue, .systemPurple), (.systemOrange, .systemYellow), (.systemIndigo, .systemCyan),
        ]
        let (top, bottom) = palette[index % palette.count]
        let image = UIGraphicsImageRenderer(size: size).image { ctx in
            let cg = ctx.cgContext
            let colors = [top.cgColor, bottom.cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width * 0.3, y: size.height), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
            UIColor.white.withAlphaComponent(0.85).setFill()
            let sun = min(size.width, size.height) * 0.18
            cg.fillEllipse(in: CGRect(x: size.width * (0.2 + 0.05 * CGFloat(index % 7)), y: size.height * 0.18, width: sun, height: sun))
            UIColor.black.withAlphaComponent(0.28).setFill()
            let hills = UIBezierPath()
            hills.move(to: CGPoint(x: 0, y: size.height * 0.72))
            hills.addQuadCurve(to: CGPoint(x: size.width * 0.55, y: size.height * 0.68), controlPoint: CGPoint(x: size.width * 0.25, y: size.height * (0.5 + 0.03 * CGFloat(index % 4))))
            hills.addQuadCurve(to: CGPoint(x: size.width, y: size.height * 0.62), controlPoint: CGPoint(x: size.width * 0.8, y: size.height * 0.8))
            hills.addLine(to: CGPoint(x: size.width, y: size.height))
            hills.addLine(to: CGPoint(x: 0, y: size.height))
            hills.close()
            hills.fill()
        }
        return image.jpegData(compressionQuality: 0.8) ?? Data()
    }
}
#endif
