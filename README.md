# Stratego Online

A real-time, two-player online [Stratego](https://en.wikipedia.org/wiki/Stratego) game — built so
two people (e.g. a long-distance couple) can play from anywhere by sharing a room code. The server is
authoritative and enforces hidden information: you never receive your opponent's piece identities
until they're revealed in battle, so there's no way to peek by inspecting network traffic.

## Features
- Full classic 10×10 Stratego rules: setup phase, all piece ranks, scouts (move + strike at range),
  Spy beats Marshal, Miners defuse Bombs, Flag capture wins, two-squares anti-stall rule.
- Room codes — one player creates a game, the other joins with the 4-character code.
- Private setup: arrange your 40 pieces (drag/tap or Auto-fill), then Ready up.
- Live play with turn indicator, captured-piece tracker, battle results, resign & rematch.
- Built-in chat so you can talk while you play.
- Reconnect: refresh or drop your connection and rejoin the same seat automatically.
- No accounts, no database — just share a link.

## Run locally
```bash
npm install
npm start
# open http://localhost:4300 in two browser tabs (or two devices on your LAN)
```
Player 1 clicks **Create Game** and shares the room code; Player 2 clicks **Join** and enters it.

## Play over the internet
See **[DEPLOY.md](DEPLOY.md)** — the quickest path is a free Render web service (no credit card, no
CLI). Once deployed you both just open the same URL.

## Tech
- `server.js` — Express (serves `public/`) + `ws` WebSocket server, in-memory rooms, authoritative
  game state and hidden-information redaction.
- `engine.js` — pure, dependency-free game logic (fully unit-tested: `npm test`).
- `public/` — vanilla-JS single-page client (no build step, no external assets).

## Tests
```bash
npm test        # runs engine unit tests via node --test
```

## Rules quick reference
Higher rank wins a battle; equal ranks both die. Exceptions: **Spy (1)** beats **Marshal (10)** only
when the Spy attacks; **Miners (3)** are the only pieces that can defeat **Bombs**; any other piece
that hits a Bomb is destroyed. **Bombs** and the **Flag** never move. **Scouts (2)** move any number
of empty squares in a straight line and may strike from a distance. Capture the enemy **Flag** — or
leave your opponent with no legal move — to win.
