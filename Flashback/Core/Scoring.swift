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

    /// Standings after a round, with each player's rank before it, for the
    /// movement arrows on the results screen.
    enum Standings {
        struct Row: Identifiable, Equatable {
            var id: String
            var score: Int
            var previous: Int
            var rank: Int
            var previousRank: Int
            /// Positive means the player climbed.
            var movement: Int { previousRank - rank }
        }

        static func rows(players: [PlayerView], result: RoundResult?) -> [Row] {
            let deltas = Dictionary(uniqueKeysWithValues: (result?.rows ?? []).map { ($0.playerID, $0.points) })
            let currentScores = Dictionary(uniqueKeysWithValues: players.map { ($0.id, $0.score) })
            let previousScores = Dictionary(uniqueKeysWithValues: players.map { ($0.id, $0.score - (deltas[$0.id] ?? 0)) })
            let joinOrder = Dictionary(uniqueKeysWithValues: players.enumerated().map { ($0.element.id, $0.offset) })

            func order(_ scores: [String: Int]) -> [String] {
                players.map(\.id).sorted { a, b in
                    let sa = scores[a] ?? 0, sb = scores[b] ?? 0
                    if sa != sb { return sa > sb }
                    return (joinOrder[a] ?? 0) < (joinOrder[b] ?? 0)
                }
            }

            let current = order(currentScores)
            let previous = order(previousScores)
            let currentRank = Dictionary(uniqueKeysWithValues: current.enumerated().map { ($0.element, $0.offset + 1) })
            let previousRank = Dictionary(uniqueKeysWithValues: previous.enumerated().map { ($0.element, $0.offset + 1) })

            return current.map { id in
                Row(
                    id: id,
                    score: currentScores[id] ?? 0,
                    previous: previousScores[id] ?? 0,
                    rank: currentRank[id] ?? players.count,
                    previousRank: previousRank[id] ?? players.count
                )
            }
        }
    }
}
