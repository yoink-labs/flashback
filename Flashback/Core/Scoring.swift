import Foundation

/// Mirrors worker/src/scoring.ts so the app can explain points. The server is the source of truth.
///
/// A correct guess earns 500 (accuracy) + up to 500 for speed
/// (round(500 × remaining ÷ round time)) + 100 per previous consecutive correct guess
/// (capped at 500). Wrong, late, or missing guesses earn 0 and reset the streak.
/// Ties: rounds rank earlier guesses first, the podium ranks less total time on
/// correct guesses first, then join order.
enum Scoring {
    static let accuracyPoints = 500
    static let speedPoints = 500
    static let streakStep = 100
    static let streakBonusCap = 5

    struct Score: Equatable {
        var correct: Bool
        var points: Int
        var accuracy: Int
        var speed: Int
        var streakBonus: Int
        var streak: Int
        static let zero = Score(correct: false, points: 0, accuracy: 0, speed: 0, streakBonus: 0, streak: 0)
    }

    static func score(correct: Bool, elapsedMs: Double?, timerMs: Double, previousStreak: Int) -> Score {
        guard correct, let elapsedMs, elapsedMs >= 0, elapsedMs <= timerMs, timerMs > 0 else { return .zero }
        // JavaScript's Math.round rounds .5 up; match it exactly.
        let speed = Int((Double(speedPoints) * (timerMs - elapsedMs) / timerMs + 0.5).rounded(.down))
        let streak = previousStreak + 1
        let bonus = streakStep * min(streak - 1, streakBonusCap)
        return Score(correct: true, points: accuracyPoints + speed + bonus, accuracy: accuracyPoints, speed: speed, streakBonus: bonus, streak: streak)
    }

    /// Points a correct guess would earn right now, for the live "up to" hint.
    static func potential(remainingMs: Double, timerMs: Double, previousStreak: Int) -> Int {
        score(correct: true, elapsedMs: max(0, timerMs - remainingMs), timerMs: timerMs, previousStreak: previousStreak).points
    }

    struct FinalRow: Equatable { var id: String; var score: Int; var correctMs: Double; var joinSeq: Int }
    static func rankFinal(_ rows: [FinalRow]) -> [FinalRow] {
        rows.sorted { ($0.score, -$0.correctMs, -$0.joinSeq) > ($1.score, -$1.correctMs, -$1.joinSeq) }
    }

    struct RoundRow: Equatable { var id: String; var points: Int; var elapsedMs: Double?; var joinSeq: Int }
    static func rankRound(_ rows: [RoundRow]) -> [RoundRow] {
        rows.sorted { a, b in
            if a.points != b.points { return a.points > b.points }
            let ta = a.elapsedMs ?? .infinity, tb = b.elapsedMs ?? .infinity
            if ta != tb { return ta < tb }
            return a.joinSeq < b.joinSeq
        }
    }
}
