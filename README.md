# Agent Cards — Self-Hosted (Railway-ready)

A self-hosted version of the **Agent Trading Cards** site: the current landing
page (perks theme, trading-card roster, arcade perks, working waitlist email
form) plus the full working demo — 7 original agent cards, QR-style activation,
team dashboard, chatbot chat with 5 providers, and a protected page-controls
login.

**Stack:** Node.js + Express (plain JavaScript) · JSON file persistence (single
`data/db.json`, atomic writes, zero native dependencies) · the production
frontend bundle (no build step needed to deploy).

---

## 1. Prerequisites

- **Node.js 20+** ([nodejs.org](https://nodejs.org)) — check with `node --version`
- An **LLM provider API key** for whichever provider(s) you want live:
  - Anthropic (`ANTHROPIC_API_KEY`) — [console.anthropic.com](https://console.anthropic.com)
  - OpenAI (`OPENAI_API_KEY`) — [platform.openai.com](https://platform.openai.com)
  - Google Gemini (`GEMINI_API_KEY`) — [aistudio.google.com](https://aistudio.google.com)
  - DeepSeek (`DEEPSEEK_API_KEY`) — [platform.deepseek.com](https://platform.deepseek.com)
  - Meta (`META_MODEL_API_KEY`) — Meta Model API (US, public preview; new accounts
    get $20 in free credits)
- (Optional) A **Resend API key** (`RESEND_API_KEY`) — [resend.com] — so the
  waitlist email form also sends you a notification per signup. Without it,
  signups are still saved to the database.

## 2. Run locally

```bash
cd agent-cards-selfhosted-v2
npm install
cp .env.example .env
# edit .env — paste at least one provider API key (+ RESEND_API_KEY for emails)
npm start
```

Open **http://localhost:3000** — landing page, demo tabs, and page controls are
all in the one app.

## 3. Deploy

### Option A — Railway (easiest)

1. Push this folder to a GitHub repo.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Railway auto-detects the Node app and sets `PORT`. No build command needed;
   start command is `npm start` (already in `package.json`).
4. In the service's **Variables** tab, add your keys:
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
   `META_MODEL_API_KEY` (at least one, or agents show honest "no key" errors),
   plus `RESEND_API_KEY` and `NOTIFY_EMAIL` for waitlist email alerts.
5. Add a **Volume** mounted at `/app/data` and set `DATA_DIR=/app/data`
   so the JSON database (activations, signups, chat history) survives redeploys.
6. In **Settings**, generate a public domain → your live URL.

### Option B — Render

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New** → **Web Service** → connect the repo.
3. Settings: **Build Command** `npm install`, **Start Command** `npm start`,
   environment **Node**.
4. Under **Environment**, add the same variables as above.
5. Add a **Disk** mounted at `/opt/render/project/data` and set `DATA_DIR`
   to that path for persistent storage.
6. Deploy — Render gives you a public `https://….onrender.com` URL.

### Option C — Plain VPS (Ubuntu)

```bash
# on the server
sudo apt update && sudo apt install -y nodejs npm
cd /opt && git clone <your-repo> agent-cards && cd agent-cards
npm install --omit=dev
cp .env.example .env && nano .env   # fill in keys
# run with pm2 (auto-restart):
sudo npm i -g pm2
pm2 start server.js --name agent-cards
pm2 startup   # follow the printed instructions
pm2 save
```

Put it behind HTTPS with nginx + Let's Encrypt (certbot).

## 4. Environment variable reference

| Variable | Required | Default | What it does |
|---|---|---|---|
| `PORT` | No | `3000` | Port to listen on (hosts set this automatically) |
| `DATA_DIR` | No | `./data` | Folder for the `db.json` database file |
| `DEFAULT_PROVIDER` | No | `meta` | Initial provider: `anthropic`, `openai`, `gemini`, `deepseek`, `meta` |
| `ANTHROPIC_API_KEY` | For Anthropic | — | Anthropic API key |
| `OPENAI_API_KEY` | For OpenAI | — | OpenAI API key |
| `GEMINI_API_KEY` | For Gemini | — | Google AI Studio API key |
| `DEEPSEEK_API_KEY` | For DeepSeek | — | DeepSeek API key |
| `META_MODEL_API_KEY` | For Meta | — | Meta Model API key |
| `RESEND_API_KEY` | For email alerts | — | Resend API key (waitlist notifications) |
| `NOTIFY_EMAIL` | No | `aivenblu@gmail.com` | Where waitlist signup alerts go |
| `RESEND_FROM` | No | `onboarding@resend.dev` | From address for alerts (verify a domain in Resend for full deliverability) |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-20250514` | Model override |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Model override |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | Model override |
| `DEEPSEEK_MODEL` | No | `deepseek-chat` | Model override |
| `META_MODEL` | No | `muse-spark-1.3` | Model override |

## 5. How it works

- **Landing page** (`/`): the current perks-theme page — hero, six trading-card
  agents, Member Pass deck, Play the Arcade perks, "the card keeps opening
  doors" section, and the working waitlist email form (3 interest lanes).
- **Demo tabs** (bottom nav): Cards, Team, Setup — card activation, chatbot
  conversations with persisted history, 5-provider picker, Limited/Unlimited
  usage switch.
- **Page controls** (protected "Cards" destination): create a username + password
  on first visit; it gates the Tabs on/off switch. Credentials are PBKDF2-hashed.
- **API**: the frontend POSTs `{ action, args }` to `/actions`; `server.js`
  implements all 11 actions (`getDashboard`, `activateAgent`, `runAgentTask`,
  `joinWaitlist`, `setupAdmin`, …) against `data/db.json`.
- **Waitlist**: `joinWaitlist` saves every signup to the database and, when
  `RESEND_API_KEY` is set, emails you a notification and attempts a subscriber
  confirmation (needs a verified Resend domain for non-account addresses).
- **Task flow**: `runAgentTask` checks activation → email gate → rate caps →
  provider API (keys stay server-side) → answer saved with routing metadata.

## 6. Honest notes

- **No key = clear error, never a faked answer.** If the selected provider has no
  API key, the chat says so honestly.
- **Costs are yours.** Every task is a real billed API call to whichever provider
  is selected, at that provider's pricing. Limited mode's caps exist to bound this.
- **Demo-grade identity.** Visitors are told apart by IP hash (no login); the
  page-controls login is a simple owner gate, not multi-user auth.
- **Run a single instance.** The JSON store is written by one Node process;
  don't run two servers against the same `DATA_DIR`.
- **Anthropic is special-cased** (native Messages API with `x-api-key`); the other
  four use the OpenAI chat-completions shape.
- The 7 demo agents are original characters (SCOUT-9, DAYSMITH, LEDGERLY,
  PITCHFORGE, SNIPPET, CONCIERGE, OMNI-1) — no third-party IP.

## 7. Project layout

```
agent-cards-selfhosted-v2/
├── server.js            # Express app + POST /actions (all 11 frontend actions)
├── db.js                # JSON file persistence (atomic writes, survives restarts)
├── agents.js            # 7 agent card definitions + system prompts
├── providers.js         # 5-provider LLM routing (keys from env only)
├── limits.js            # Limited-mode email gate + rate caps
├── public/
│   ├── index.html       # current landing page + demo SPA
│   └── assets/          # styles, scripts, artwork
├── .env.example         # copy to .env and fill in
├── package.json         # npm install && npm start — that's the whole build
└── data/db.json         # created at runtime (gitignored)
```

## 8. API quick reference

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Health check |
| `POST /actions` | `{ action, args }` → `{ data }` or `{ error }`. Actions: `getDashboard`, `activateAgent`, `setProvider`, `setUsageMode`, `getAdminStatus`, `setupAdmin`, `loginAdmin`, `setDemoNavigation`, `joinWaitlist`, `unlockWithEmail`, `runAgentTask` |
