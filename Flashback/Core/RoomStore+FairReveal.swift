import Foundation

// Milestone 5 §3, §4: the scheduled reveal. When the countdown's fixed time
// passes and the round's media is decoded, this device shows the reveal by
// itself and holds the first pick until the server's reveal state arrives.
extension RoomStore {
    /// The room view the UI shows. During a locally started reveal the fixed
    /// countdown is dressed as a reveal so every timer and effect reads the
    /// same fields as the server's reveal state.
    var displayedView: RoomView? {
        guard let view else { return nil }
        guard let key = localRevealKey, view.phase == .countdown,
              view.game == key.game, let round = view.round, round.index == key.round,
              let revealAt = round.revealAt else { return view }
        let endsAt = revealAt + Double(max(1, view.settings.timerSeconds)) * 1000
        let held = heldGuess.flatMap { $0.game == key.game && $0.round == key.round ? $0 : nil }
        var shown = view
        shown.phase = .reveal
        shown.phaseEndsAt = endsAt
        shown.round = RoundView(
            index: round.index,
            total: round.total,
            kind: round.kind,
            revealAt: revealAt,
            endsAt: endsAt,
            canGuess: !view.paused,
            yourGuess: held?.targetID,
            guessedCount: held == nil ? 0 : 1,
            guesserCount: max(1, view.players.filter(\.connected).count - 1),
            yourEffect: round.yourEffect,
            effect: round.effect,
            eliminated: round.eliminated
        )
        return shown
    }

    /// Whether this device may take a guess right now, including during a
    /// locally started reveal before the reveal state has arrived.
    var canGuessNow: Bool {
        guard let view else { return false }
        if localRevealKey != nil {
            let heldHere = heldGuess.map { $0.game == view.game && $0.round == view.round?.index } ?? false
            return !view.paused && !heldHere
        }
        return view.canGuess
    }

    /// A tap on a player. In a locally started reveal the pick is shown as
    /// selected and held; it is sent when the reveal state arrives (§3).
    func guess(_ targetID: String) {
        guard canGuessNow else { return }
        let elapsedMs = GuessTiming.elapsedMs(
            tapAt: serverNow,
            revealAt: view?.round?.revealAt,
            firstShownAt: revealShownAt
        )
        if localRevealKey != nil {
            heldGuess = HeldGuess(
                targetID: targetID,
                elapsedMs: elapsedMs,
                game: view?.game ?? 0,
                round: view?.round?.index ?? 0
            )
        } else {
            send(.guess(targetID, elapsedMs: elapsedMs))
        }
        Haptics.lock()
    }

    /// Sends a pick held during a locally started reveal, with the elapsed
    /// time measured at the tap (§3, §4). A pick from another round is dropped.
    func flushHeldGuess() {
        guard let held = heldGuess else { return }
        heldGuess = nil
        guard view?.canGuess == true, view?.game == held.game,
              view?.round?.index == held.round else { return }
        send(.guess(held.targetID, elapsedMs: held.elapsedMs))
    }

    /// Starts the reveal locally when the countdown's fixed time has passed and
    /// the media is ready; otherwise keeps a light watcher so it flips the
    /// instant both are true (§3).
    func syncLocalReveal() {
        guard let view, view.phase == .countdown, localRevealKey == nil else {
            stopRevealWatcher()
            return
        }
        guard !view.paused, let round = view.round, let revealAt = round.revealAt else {
            stopRevealWatcher()
            return
        }
        let key = MediaKey(game: view.game, round: round.index)
        if LocalReveal.shouldReveal(
            phase: view.phase,
            paused: view.paused,
            revealAt: revealAt,
            serverNow: serverNow,
            mediaReady: readyMedia.contains(key)
        ) {
            beginLocalReveal(key: key, round: round)
        } else {
            startRevealWatcher()
        }
    }

    /// Re-checks the local reveal; true once it has started.
    func checkLocalReveal() -> Bool {
        syncLocalReveal()
        return localRevealKey != nil
    }

    private func beginLocalReveal(key: MediaKey, round: RoundView) {
        stopRevealWatcher()
        localRevealKey = key
        showReveal(key, kind: round.kind)
        Haptics.reveal()
        syncPlayback()
    }

    func endLocalReveal() {
        stopRevealWatcher()
        localRevealKey = nil
    }

    private func startRevealWatcher() {
        guard revealWatcher == nil else { return }
        revealWatcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, !Task.isCancelled else { return }
                if self.checkLocalReveal() { return }
            }
        }
    }

    private func stopRevealWatcher() {
        revealWatcher?.cancel()
        revealWatcher = nil
    }
}
