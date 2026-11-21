// A refused request, with the HTTP status (or WebSocket error) clients show.
// Lives in its own module so settings, effects, shop and the game can all throw
// it without importing the game state machine.
export class GameError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
