# Deploying Stratego Online

The app is a single Node.js server that also serves the web client, so any host that runs Node and
supports WebSockets works. Below, easiest first.

---

## Option 1 — Render (recommended, free, no CLI, no card)

1. Put this project on GitHub (create a repo, push these files).
2. Go to <https://render.com> and sign up (free).
3. **New +** → **Web Service** → connect your GitHub repo.
4. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Create the service. Render gives you a URL like `https://your-app.onrender.com`.
6. Share that URL with your partner. One of you clicks **Create Game**, sends the room code; the
   other clicks **Join**.

Notes: Render's free tier sleeps after ~15 min idle and takes ~30s to wake on the next visit — fine
for casual play. WebSockets are supported on the free tier. `PORT` is provided automatically; the
server already reads `process.env.PORT`.

---

## Option 2 — Railway or Fly.io
- **Railway** (<https://railway.app>): New Project → Deploy from GitHub repo. It auto-detects Node,
  runs `npm install` + `npm start`. No extra config needed.
- **Fly.io** (needs the `fly` CLI): `fly launch` (accept Node defaults, no DB), then `fly deploy`.
  Ensure the internal port matches `process.env.PORT` (Fly sets it) or set it in `fly.toml`.

---

## Option 3 — Run on your own machine + a tunnel (no signup for the app)
Good if you just want to play right now from your laptop.
```bash
npm install && npm start        # serves on http://localhost:4300
```
Expose it with a tunnel in another terminal:
```bash
# Cloudflare (no account needed for quick tunnels):
npx cloudflared tunnel --url http://localhost:4300
#   -> prints a https://<random>.trycloudflare.com URL to share
# or ngrok (needs a free ngrok account/token):
npx ngrok http 4300
```
Share the printed HTTPS URL. Keep your machine and the terminal running while you play.

---

## Environment
- `PORT` — port to listen on (defaults to `4300`). All recommended hosts set this for you.

No other configuration, secrets, or database is required.
