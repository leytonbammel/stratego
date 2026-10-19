# Computer Opponent Options

The server is authoritative, so a bot can run server-side as a third kind of "player" in a room,
seeing only the redacted view a human gets. The engine covers part of what a bot needs, but not all
of it:

- `redactView` returns only the current board and `lastMove`, with no move history. Under
  `revealMode: "oneturn"` revealed ranks also go dark again. Any bot smarter than random therefore has
  to **remember** what it has seen, so it must be stateful (see "Enemy tracker" below).
- `legalMoves(gameState, color)` takes the full `gameState`, not a view, and the two-squares rule
  reads `history[color]`, which `redactView` leaves out. The simplest fix is for the server to pass
  `engine.legalMoves(room.gameState, botColor)` with the view. That leaks nothing: legality depends
  only on where pieces are, who owns them and the bot's own moves.
- Piece `id`s are stable for the whole game and appear in the redacted view, so enemy pieces can be
  tracked across turns. They don't leak rank, because the client sends its placement in board order
  (`app.js` `readySetup`).

## 1. Random legal mover
Pick a random move from the legal moves, and use a random auto-fill for setup.
- **Effort:** about half a day, mostly the server refactor described under "Integration".
- **Quality:** useless as practice. It walks pieces into bombs and trades a Marshal for a Scout.
- **Value:** a good scaffold for plumbing, such as server integration, "vs Computer" UI and turn timing.

## 2. Heuristic or rule-based bot
Built on the enemy tracker from the start, since several rules need memory. Hand-written priorities,
in order:
1. Attack a known enemy piece you outrank.
2. **Defend:** move a revealed piece away from an adjacent known stronger enemy, and keep the Spy
   near a revealed enemy Marshal so it can strike.
3. **Guard the flag:** block or trade with pieces approaching the flag area, especially known Miners.
4. Use a Scout to probe unknown pieces.
5. Send Miners at pieces that never moved, since those are likely bombs or the flag.
6. Don't attack unknown pieces with high-value ones.
7. **Fallback goal:** otherwise, advance toward unexplored enemy pieces, so the bot doesn't shuffle
   aimlessly.

Two items from the earlier list were dropped. "Capture the flag if adjacent" never fires, because the
Flag can't move or attack, so it is only revealed when captured, which ends the game. "Avoid the
two-squares rule" comes free, because `legalMoves` already filters those moves out.

Setup would use a few hand-designed templates (flag at the back with bombs around it, Miners kept
back) with some randomization.
- **Effort:** a day or so, plus tuning, once the tracker exists.
- **Quality:** a decent beginner-to-intermediate opponent. Predictable once you learn its habits, but
  fine for practice.
- **Best value for the effort.**

## 3. Belief-tracking bot (the strong version of 2)
The tracker's bookkeeping already narrows every unknown enemy piece:
- A piece that moved can't be a Bomb or Flag.
- A piece that moved more than one square is a Scout.
- Battles reveal both pieces' ranks, so the remaining counts of each rank keep shrinking.

This option adds the probabilistic part on top: a distribution over each unknown piece's rank,
constrained by those facts and the remaining counts, with moves scored by expected value under it.
Behavior can sharpen the guesses too; for example, a piece charging at your revealed Captain is
probably stronger than a Captain.
- **Effort:** a couple of days beyond option 2, since the bookkeeping is already done.
- **Quality:** noticeably stronger and more human-like. It does **not** bluff or exploit your habits
  on its own; that would need a model of what the opponent believes, or learning across games.

## 4. Search-based (Expectimax or Monte Carlo)
- **Determinized MCTS:** sample a plausible assignment of the hidden enemy pieces, play out games, and
  repeat many times (Perfect Information Monte Carlo).
- **Expectimax:** a shallow search over beliefs from option 3.

The branching factor is high, but depth 2-3 with a decent evaluation function is feasible in Node.
`applyMove` changes the state in place, so every rollout has to start from a cloned state.
- **Effort:** a week or more.
- **Quality:** strong tactically, but weak at long-term strategy unless the evaluation is good.
- **Cost:** CPU. Run it in a worker thread, or it will block the WebSocket server on a free Render
  instance.

## Enemy tracker (shared by options 2-4)
A pure module (`tracker.js`, built) that follows each enemy piece by `id`:
- `observe(view, battle)` runs once with the opening position, then every ply, including the
  human's moves. It uses `lastMove` to record which piece moved and how far, and the `battle`
  message to record revealed ranks.
- Per piece it records: known rank (a Scout given away by a long move counts as known) and has
  moved.
- Globally it tracks the remaining count of each enemy rank. `possibleRanks(id)` and
  `unknownCounts()` give options 2 and 3 what they need to reason about unknown pieces.

**Perfect memory vs `oneturn`:** a bot that remembers every reveal effectively plays `oneturn` rooms
as if they were `permanent`. Redaction already controls what it *sees*; what it *remembers* is a
design choice. Either accept it (a human taking notes could do the same) or have easier difficulty
tiers deliberately forget reveals after a few turns.

## Integration (the same for all options)
- **Refactor first:** move handling is written inline in the WebSocket message handler and keyed on
  `wsColor`. Extract a `handleMove(room, color, from, to)` function that both the socket path and the
  bot call.
- **Bot seat:** `room.players[color]` gets `{ bot: true, ws: null, ... }`. `sendTo` and
  `broadcastToRoom` already do nothing when there's no socket. Code that reads `connected` needs to
  handle the bot seat:
  - The idle-room cleanup checks `!sConn && !nConn`. If the bot counts as connected, rooms are never
    cleaned up after the human leaves. Clean up based on the human seat only.
  - `sendSetupStatus` and the "opponent left" notice must report the bot as present.
  - Rematch (`wantsRematch`), host settings changes and ending the room all assume two sockets.
- **Bot API:** the server calls `bot.chooseSetup()`, `bot.observe(view, battle)` after every move,
  and `bot.chooseMove(view, legalMoves)` on the bot's turn, then sends the result through
  `handleMove`. The bot can't cheat if it only ever gets `redactView` output and its own legal moves.
- **Setup order:** `chooseSetup()` must return its placement in board order or shuffled. Ids are
  assigned in placement order, so a placement built by looping over `RANKS` would make id 1 the
  Marshal and leak the bot's whole army to anyone with devtools.
- **Think-delay:** wait about 500-1000 ms so moves feel natural. When the timer fires, check that the
  room still exists and that the phase and turn haven't changed.
- **Testing:** bot logic sits in its own module, such as `bot.js`, and is pure like `engine.js`, so it
  can be unit-tested and run bot-vs-bot. The engine has no draw or move-limit rule, so the bot-vs-bot
  harness needs a ply cap.
- **Client:** a "Play vs Computer" button creates a room with the bot already seated and ready. A
  difficulty setting switches between bot tiers.

## Recommendation
1. **Plumbing:** extract `handleMove`, add the bot seat, build the random bot (option 1), and write a
   Node script that runs bot-vs-bot games with a ply cap.
2. **Tracker:** build the enemy tracker as a pure, unit-tested module.
3. **Heuristic bot (option 2)** on top of the tracker, including defense and the fallback goal.
   Measure it against the random bot.
4. **Expected-value scoring (option 3)** using the tracker's probabilities.
5. Move to option 4 only if option 3 proves too easy.
