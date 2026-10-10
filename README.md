# 💰 CashAutoQuest

Full-auto Discord quest engine with per-user tracking, reward history, leaderboards, and global stats.

---

## File Structure

```
cashautoquest/
├── src/
│   ├── index.js      — Bot entry point, client setup, event handlers
│   ├── engine.js     — Token store, stats store, autoquest store, Discord API client, quest engine
│   └── commands.js   — All 13 slash + prefix commands
├── data/             — Auto-created on first run
│   ├── tokens.json   — AES-256-GCM encrypted user tokens
│   ├── stats.json    — Per-user stats and reward history
│   └── autoquest.json — Autoquest opt-in list
├── .env.example
├── package.json
└── README.md
```

---

## Setup

```bash
# 1. Clone / extract
cd cashautoquest

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Fill in DISCORD_TOKEN and DISCORD_CLIENT_ID

# 4. Run
npm start
```

---

## Commands

| Command | Description |
|---|---|
| `/link` | Link your Discord account token |
| `/unlink` | Remove your token + disable autoquest |
| `/quest` | View active quests and complete one interactively |
| `/questall` | Auto-complete ALL active quests back to back |
| `/claim` | Claim rewards for all completed quests |
| `/autoquest` | Toggle auto-completion (runs every 5 min) |
| `/stats` | Your personal stats: completions, streak, time, by type |
| `/history` | Last 10 completed quests with timestamps |
| `/leaderboard` | Top 10 users by total completions |
| `/globalstats` | Bot-wide totals: quests, claims, users, hours |
| `/resetstats` | Reset your personal stats to zero |
| `/ping` | Bot latency |
| `/help` | Full command list |

All commands also work with the prefix (default `,,`): `,,quest`, `,,stats`, etc.

---

## What's Improved Over the Original

| Feature | Original | CashAutoQuest |
|---|---|---|
| File count | 24 files | **3 files** |
| Stats tracking | ❌ | ✅ Per-user + global |
| Reward history | ❌ | ✅ Last 100 entries |
| Streak tracking | ❌ | ✅ |
| Leaderboard | ❌ | ✅ Top 10 |
| Global stats | ❌ | ✅ |
| History command | ❌ | ✅ |
| Reset stats | ❌ | ✅ |
| Run all quests | ❌ | ✅ `/questall` |
| Live progress bar | ❌ | ✅ In-message updates |
| DM on autoquest complete | ✅ | ✅ + includes stats |
| Token auto-revoke on 401 | ✅ | ✅ |
| AES-256-GCM encryption | ✅ | ✅ |
| Rate limit handling | ✅ | ✅ |
| Exponential backoff | ✅ | ✅ |
