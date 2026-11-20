import XCTest
@testable import Flashback

/// Same cases as worker/test/scoring.test.ts so the two implementations stay in step.
final class ScoringTests: XCTestCase {
    let timer = 20_000.0

    func testCorrectGuessEarnsAccuracyPlusSpeed() {
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: 0, timerMs: timer, previousStreak: 0),
                       .init(correct: true, points: 1000, accuracy: 500, speed: 500, streakBonus: 0, streak: 1))
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: 5_000, timerMs: timer, previousStreak: 0).points, 875)
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: 20_000, timerMs: timer, previousStreak: 0).points, 500)
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: 6_667, timerMs: timer, previousStreak: 0).speed, 333)
        // JavaScript Math.round rounds halves up: 500 × 1/1000 → 0.5 → 1.
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: 19_980, timerMs: timer, previousStreak: 0).speed, 1)
    }

    func testWrongMissingAndLateGuessesScoreZeroAndResetStreak() {
        XCTAssertEqual(Scoring.score(correct: false, elapsedMs: 100, timerMs: timer, previousStreak: 4), .zero)
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: nil, timerMs: timer, previousStreak: 4), .zero)
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: 20_001, timerMs: timer, previousStreak: 4), .zero)
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: -1, timerMs: timer, previousStreak: 4), .zero)
    }

    func testStreakBonusIsCapped() {
        let bonus = { (streak: Int) in Scoring.score(correct: true, elapsedMs: self.timer, timerMs: self.timer, previousStreak: streak).streakBonus }
        XCTAssertEqual([0, 1, 2, 3, 4, 5, 6, 10].map(bonus), [0, 100, 200, 300, 400, 500, 500, 500])
        XCTAssertEqual(Scoring.score(correct: true, elapsedMs: 0, timerMs: timer, previousStreak: 2).points, 1200)
    }

    func testPotentialPointsCountDown() {
        XCTAssertEqual(Scoring.potential(remainingMs: 20_000, timerMs: timer, previousStreak: 0), 1000)
        XCTAssertEqual(Scoring.potential(remainingMs: 0, timerMs: timer, previousStreak: 1), 600)
    }

    func testRoundTieBreaks() {
        let rows: [Scoring.RoundRow] = [
            .init(id: "c", points: 800, elapsedMs: 3000, joinSeq: 3),
            .init(id: "a", points: 800, elapsedMs: 3000, joinSeq: 1),
            .init(id: "b", points: 800, elapsedMs: 2000, joinSeq: 2),
            .init(id: "d", points: 0, elapsedMs: nil, joinSeq: 4),
            .init(id: "e", points: 0, elapsedMs: 100, joinSeq: 5),
            .init(id: "f", points: 900, elapsedMs: 9000, joinSeq: 6),
        ]
        XCTAssertEqual(Scoring.rankRound(rows).map(\.id), ["f", "b", "a", "c", "e", "d"])
    }

    func testPodiumTieBreaks() {
        let rows: [Scoring.FinalRow] = [
            .init(id: "late", score: 1500, correctMs: 9000, joinSeq: 1),
            .init(id: "top", score: 2000, correctMs: 9999, joinSeq: 4),
            .init(id: "early", score: 1500, correctMs: 4000, joinSeq: 3),
            .init(id: "tie2", score: 1500, correctMs: 9000, joinSeq: 2),
        ]
        XCTAssertEqual(Scoring.rankFinal(rows).map(\.id), ["top", "early", "late", "tie2"])
    }
}
