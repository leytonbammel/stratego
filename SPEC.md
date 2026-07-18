# Stratego Online — Build Specification (authoritative)

This document is the single source of truth. Every component must conform exactly to the
interfaces, message shapes, and rules below so the independently-built parts fit together.
Do not invent alternative names or message types. If something is unspecified, choose the
simplest option consistent with this document.

Target: a deploy-ready real-time 2-player online Stratego game. Node.js, no build step.
Server is authoritative and enforces hidden information (a client never receives an enemy
piece's identity unless it has been revealed in battle).

Node version: 22. Modules: **CommonJS** (`require`/`module.exports`). Only deps: `express`, `ws`.

---

## 1. File layout

```
stratego/
  package.json         (already created — do not overwrite; scripts: start, test)
  engine.js            (pure game logic, no I/O, no deps)   <- Component A
  engine.test.js       (node:test unit tests for engine)     <- Component A
  server.js            (express static + ws + rooms + protocol) <- Component B
  public/
    index.html         (single page)                          <- Component C
    style.css                                                  <- Component C
    app.js             (client: ws + rendering + setup + play) <- Component C
  README.md / DEPLOY.md (written separately)
```

---

## 2. Game rules (classic Stratego, 10x10)

### Board
- 10 columns (c: 0..9) x 10 rows (r: 0..9). Row 0 is the top.
- Two 2x2 lakes (impassable water): squares (r,c) where r in {4,5} and c in {2,3} OR c in {6,7}.
  i.e. lake squares = (4,2)(4,3)(5,2)(5,3)(4,6)(4,7)(5,6)(5,7).
- Players: `"north"` (home rows 0,1,2,3) and `"south"` (home rows 6,7,8,9).
  Rows 4 and 5 are neutral battlefield (minus lakes). North is displayed at top, South at bottom.

### Pieces (40 per player)
rank is a **number 1..10** for mobile ranked pieces, or the string `"B"` (Bomb) or `"F"` (Flag).
Higher number = stronger. Counts per player:

| rank | name       | count |
|------|------------|-------|
| 10   | Marshal    | 1 |
| 9    | General    | 1 |
| 8    | Colonel    | 2 |
| 7    | Major      | 3 |
| 6    | Captain    | 4 |
| 5    | Lieutenant | 4 |
| 4    | Sergeant   | 4 |
| 3    | Miner      | 5 |
| 2    | Scout      | 8 |
| 1    | Spy        | 1 |
| "B"  | Bomb       | 6 |
| "F"  | Flag       | 1 |

Total = 40.

### Movement
- Bomb (`"B"`) and Flag (`"F"`) never move.
- Ranks 1,3,4,5,6,7,8,9,10 move exactly ONE square orthogonally (up/down/left/right) to an
  empty square, or onto an enemy-occupied square (an attack).
- Scout (rank 2) moves any number of squares orthogonally in a straight line over EMPTY squares
  (may not pass through or over any piece or lake); it may stop on the first enemy piece in that
  line to attack it (move + attack in the same turn, any distance).
- No diagonal moves. Cannot move onto your own piece. Cannot enter or cross lake squares. Cannot leave the board.

### Combat (attacker A moves onto defender D)
Resolve in this order:
1. If D is Flag `"F"`: A wins, **game over**, A's owner wins the game.
2. If D is Bomb `"B"`: if A is a Miner (rank 3) → A wins, bomb removed, A moves in. Otherwise A is
   destroyed, bomb remains.
3. Both are ranked numbers:
   - Spy special: if A is Spy (rank 1) and D is Marshal (rank 10) → A wins (Spy defeats Marshal only
     when the Spy is the attacker). (If Marshal attacks Spy, Marshal wins normally.)
   - Else if A.rank > D.rank → A wins (D removed, A moves in).
   - Else if A.rank < D.rank → A destroyed (D remains).
   - Else equal rank → both removed (square becomes empty).
- "Winner moves in" = winner occupies D's square and its origin square becomes empty.
- Any piece that participates in a battle becomes **revealed** (`revealed=true`) permanently. A
  surviving winner stays revealed to both players.

### Turn order
- Host (room creator) is assigned color `"south"` and moves first. The joiner is `"north"`.
- Turns strictly alternate.

### Two-squares rule (anti-stall)
A piece may not oscillate between two squares indefinitely. Concrete enforced rule:
- Maintain per player a history of that player's own moves as `{from:[r,c], to:[r,c]}`.
- A candidate move `(from,to)` is ILLEGAL if the player's two most recent moves were exactly
  `to->from` (most recent) and `from->to` (the one before), i.e. the piece has already gone
  `from->to`, `to->from`, and this move would be `from->to` a third time in a row. In other words a
  player may not make the same `from->to` move for a 3rd time when it has been strictly alternating
  with its reverse in between. This blocks 3x repetition of the same shuttle.

### End conditions
- Flag captured → capturer's owner wins (reason `"flag"`).
- A player whose turn it is has **zero legal moves** → that player loses (reason `"no-moves"`).
- Resign → resigner loses (reason `"resign"`).

---

## 3. Component A — `engine.js` (pure, no dependencies)

Export (CommonJS) an object with AT LEAST these members. Internal representation is your choice as
long as behavior and these signatures hold.

```js
module.exports = {
  RANKS,          // array/def of ranks with names + counts (see table). e.g. RANK_COUNTS map.
  RANK_NAMES,     // { 10:"Marshal", ... "B":"Bomb", "F":"Flag" }
  isLake,         // (r,c) => boolean
  homeRows,       // (color) => [r0,r1,r2,r3]  north->[0,1,2,3], south->[6,7,8,9]
  validateSetup,  // (placement, color) => { ok:boolean, error?:string }
  createGame,     // (setupSouth, setupNorth) => gameState  (south moves first)
  isLegalMove,    // (gameState, color, from, to) => { ok:boolean, error?:string }
  legalMoves,     // (gameState, color) => Array<{from:[r,c], to:[r,c]}>
  applyMove,      // (gameState, color, from, to) => { state, battle, gameOver, winner, reason }
  redactView,     // (gameState, color) => clientView   (hides unrevealed enemy identities)
  checkGameOver,  // (gameState) => { over:boolean, winner?:color, reason?:string }
};
```

Definitions:
- **placement**: array of exactly 40 objects `{ rank, r, c }` where rank matches the counts table,
  all cells distinct, and every cell is within that color's home rows. `validateSetup` returns
  `{ok:false, error}` if counts are wrong, cells out of home rows, duplicates, wrong total, or a
  cell is a lake (home rows are never lakes, but validate anyway).
- **gameState** (internal, server-held) suggested shape:
  ```js
  {
    board,      // 10x10 array; each cell null OR { rank, owner, revealed:boolean, id:number }
    turn,       // "south" | "north"
    phase,      // "play"
    winner,     // null | "south" | "north"
    reason,     // null | "flag" | "no-moves" | "resign"
    history,    // { south:[{from,to}], north:[{from,to}] }  (for two-squares rule)
    lastMove,   // null | { from, to, color }  (for UI highlight)
  }
  ```
- `createGame(setupSouth, setupNorth)`: builds board from both placements, sets `turn="south"`,
  `phase="play"`. Each piece gets a unique `id` and `revealed:false`.
- `applyMove`: MUST re-validate legality (throw or return error state is NOT allowed — instead
  callers only pass validated moves, but applyMove should still guard). It mutates/returns new
  state, sets `lastMove`, appends to `history[color]`, flips `turn`, applies combat, sets
  `winner/reason` when the game ends. Returns `battle` = null for a non-attacking move, otherwise
  `{ from, to, attacker:{rank,owner}, defender:{rank,owner}, outcome:"attacker"|"defender"|"both" }`
  (outcome = who survived; "both" = mutual destruction). After a move that ends the game set
  `gameOver:true, winner, reason`. Also: after flipping turn, if the new player has zero legal
  moves, the game ends with that player losing (reason "no-moves").

### `redactView(gameState, color)` — the client view (hidden-info boundary)
Returns a JSON-safe object the server sends to the client for `color`:
```js
{
  you: color,                       // "south" | "north"
  turn, phase, winner, reason,
  lastMove,                         // {from,to,color} | null
  board: [ /* 10x10 */ ],           // each cell one of:
  //   null                                   (empty)
  //   "lake"                                  (water)
  //   { own:true,  rank, revealed, id }       (your piece — full rank always)
  //   { own:false, revealed, rank? , id }     (enemy — rank ONLY present if revealed===true)
  counts: { south:{captured:{...}}, north:{...} } // OPTIONAL captured tally; may omit if hard
}
```
CRITICAL: for enemy pieces with `revealed===false`, DO NOT include the real rank anywhere in the
returned object. This is the anti-cheat boundary and is unit-tested.

### Required unit tests in `engine.test.js` (use `node:test` + `node:assert`)
Cover at minimum:
1. `validateSetup`: valid full placement passes; wrong counts fail; out-of-home-row fails; duplicate cell fails.
2. Movement: one-step orthogonal ok; diagonal rejected; moving into lake rejected; onto own piece rejected.
3. Scout: long straight move over empty ok; blocked by intervening piece rejected; scout attack at distance ok.
4. Combat: higher beats lower; equal both die; Spy(1) attacking Marshal(10) wins; Marshal attacking Spy wins;
   Miner(3) vs Bomb wins/removes bomb; non-miner vs Bomb → attacker dies; attacking Flag ends game.
5. `redactView`: unrevealed enemy cell has no `rank` field; revealed enemy cell includes `rank`; own cells include rank.
6. Two-squares rule: third repetition of the same shuttle move is rejected.
7. `checkGameOver`: no-legal-moves detection for a player.
All tests must pass with `node --test`.

---

## 4. Component B — `server.js` (express + ws)

Responsibilities: serve `public/`, manage rooms, hold authoritative `gameState`, enforce turns &
legality via `engine.js`, send each client only its redacted view, support reconnect & chat.

- `const engine = require('./engine');`
- Serve static: `app.use(express.static('public'))`. Listen on `process.env.PORT || 3000`.
- Attach a `ws` `WebSocketServer` to the same HTTP server (share the port). Path: default `/`.
- **Rooms** (in-memory `Map<roomCode, room>`). `roomCode` = 4-char uppercase alphanumeric,
  unambiguous (no O/0/I/1). A room:
  ```js
  {
    code,
    players: {                 // seat -> player or null
      south: { token, ws, connected, placement:null|[], ready:false } | null,
      north: { ... } | null
    },
    gameState: null,           // set once both ready -> engine.createGame(...)
    chat: []                   // optional recent messages
  }
  ```
- **Session token**: on create/join, generate a random `token` (uuid-ish). Return it to the client;
  client stores in localStorage and may reconnect with `{type:"reconnect", roomCode, token}` to
  reclaim its seat (re-bind `ws`, resend state).

### Client -> Server messages (JSON)
- `{ type:"create" }`
- `{ type:"join", roomCode }`
- `{ type:"reconnect", roomCode, token }`
- `{ type:"setup", placement:[{rank,r,c} x40] }`   // sets this seat's placement + ready=true
- `{ type:"move", from:[r,c], to:[r,c] }`
- `{ type:"chat", text }`
- `{ type:"resign" }`
- `{ type:"rematch" }`   // both seats must send; then re-enter setup with fresh empty placements

### Server -> Client messages (JSON)
- `{ type:"created", roomCode, color:"south", token }`
- `{ type:"joined", roomCode, color:"north", token }`
- `{ type:"error", message }`
- `{ type:"phase", phase }` where phase in `"waiting"` (opponent not joined), `"setup"` (both present,
  place your pieces), `"play"`, `"gameover"`. Send whenever it changes.
- `{ type:"state", view }`  // view = engine.redactView(gameState, thisColor). Send to each client
  after every move/reconnect. During setup, send a setup-phase indicator (opponentReady bool).
- `{ type:"setupStatus", youReady, opponentReady, opponentPresent }`
- `{ type:"battle", battle }`   // the engine battle object, sent to BOTH clients after an attack
- `{ type:"gameover", winner, reason }`  // send to both
- `{ type:"chat", from:"you"|"opponent", text }`
- `{ type:"opponent", status:"left"|"joined"|"reconnected" }`

### Rules the server enforces
- Reject `move` if not that seat's turn, if phase != play, or if `engine.isLegalMove` fails
  (reply with `{type:"error"}`, do not change state).
- On valid move: call `engine.applyMove`, then send updated redacted `state` to EACH connected
  client (each gets its own redaction), send `battle` to both if an attack occurred, and if game
  over send `gameover` + set phase `"gameover"`.
- Setup: when both seats have submitted valid placements, call `engine.createGame(south, north)`,
  set phase `"play"`, send state to both. Validate each placement with `engine.validateSetup`.
- Reconnect must restore correct redaction and current phase.
- Handle ws close: mark player disconnected, notify opponent `{type:"opponent",status:"left"}`;
  keep room alive for a grace period (e.g. 5 min) so reconnect works. GC empty rooms.

Keep server.js self-contained and readable. No auth beyond room code + token.

---

## 5. Component C — `public/` frontend (vanilla JS, no framework, no build)

Single-page app. Clean, pleasant, responsive; playable on desktop and mobile. Dark theme, board
clearly readable, own pieces show rank/name, enemy pieces show a face-down look unless revealed.

`index.html`: loads `style.css` and `app.js` (`<script src="app.js"></script>`). Contains containers
for: a lobby screen (Create Game / Join with code input), a setup screen (board + tray of pieces to
place + Auto-fill + Clear + Ready buttons + shareable room code display), a play screen (board,
turn indicator, captured pieces, chat panel, resign/rematch buttons), and a status/toast area.

`app.js` behavior:
- Open a WebSocket to `location.origin` (use `new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host)`).
- Lobby: "Create Game" -> send `{type:"create"}`, show the returned room code + a copyable share
  hint ("send this code to your partner"). "Join" -> `{type:"join", roomCode}`.
- Persist `{roomCode, token, color}` in localStorage; on load, if present, send `reconnect` first.
- Setup screen: render own home rows (south at bottom for south player, north at top for north
  player — but ALWAYS render the local player's home at the BOTTOM of their own screen for
  intuitiveness; flip the board so "you" are always at the bottom). Provide drag-and-drop OR
  tap-to-place from a tray showing remaining counts of each rank. Provide "Auto-fill random",
  "Clear", and "Ready" (Ready enabled only when all 40 placed). On Ready send `{type:"setup",
  placement}`. Show waiting indicator until opponent is ready.
- Play screen: render the 10x10 board with lakes styled as water. Your pieces show name/rank; enemy
  unrevealed pieces show a generic face-down token; revealed enemy pieces show their rank. Click your
  piece to select (highlight legal destinations from the last `state` — compute legal destinations
  client-side for UX, but the SERVER is authoritative), click a destination to send `{type:"move"}`.
  Show whose turn it is; disable input when it is not your turn. Animate/toast battle results
  ("Your Scout (2) attacked their Major (7) — you lost"). Show captured pieces per side.
- Board orientation: always draw so the local player's side is at the bottom. Convert between screen
  coordinates and absolute board coords accordingly (for north, screen is the board rotated 180°).
- Chat panel: input + send `{type:"chat"}`; render incoming `chat` messages (from you/opponent).
- Handle `gameover`: show winner/reason and a Rematch button (sends `{type:"rematch"}`).
- Handle `opponent left/reconnected` with a toast.
- Reconnect gracefully on socket close (retry with backoff, then re-send reconnect).

Coordinates in all messages are ABSOLUTE board coords (r 0..9 top-based, c 0..9), never screen
coords. Only the rendering flips.

Design: modern, warm but legible. Use CSS grid for the board. Rank tokens are circular/rounded chips
with the number and a short label. Lakes a distinct blue. Selected piece + legal targets highlighted.
Keep it a couple hundred lines of clean CSS max; no external assets/fonts (system font stack).

---

## 6. Acceptance
- `node --test` passes (engine tests).
- `node server.js` starts; two browser tabs can create/join a room, place pieces, and play a full
  game to flag capture, with enemy identities hidden until revealed in battle.
- No enemy rank data is ever sent to a client for unrevealed pieces (verify in redactView + server).
