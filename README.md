# cebuliga

<p align="center">
  <img src="public/ssz_cebularz_lublin.png" alt="SSZ Cebularz Lublin" width="180" />
</p>

<p align="center">
  Tournament info site for the 1st Chess League<br/>
  <em>SSZ Cebularz Lublin chess community</em>
</p>

---

## What is this and why does it exist?

We play chess online. Informally. On Discord. No clocks, no arbiter, no good reason — pure hobby.

Someone still had to figure out who hasn't played whom yet, who's in the lead, and whether anything is even happening. A Google Sheet would require clicking. So obviously: **we built a separate website**.

Because why not.

---

## How the league works

The organiser draws up pairings. Players arrange a time among themselves and play on [chess.com](https://chess.com). Weekly deadlines — loosely enforced. This is a _chess_ community, not a _disciplinary_ one.

Supported formats:

- **Round-robin** — everyone plays everyone, in any order within the deadline
- **Swiss** — fixed rounds, pairings generated after each round
- Optional split into **two groups** from the same player pool (for fun, because we like rankings)

---

## Tech stack, or: how hard can you overengineer a tournament tracker

A results page for a casual online chess club. No backend. No database. No login. No runtime API calls. **Static HTML generated from JSON files** — because why keep it simple when you can achieve the same thing with 400 lines of TypeScript, GitHub Actions, and Cloudflare Pages.

| Layer     | Choice                 | Reason                                              |
| --------- | ---------------------- | --------------------------------------------------- |
| Framework | **Astro + TypeScript** | SSG, zero JS by default, still feels modern         |
| Data      | **JSON in `data/`**    | Git as both database and audit log                  |
| Hosting   | **Cloudflare Pages**   | Free tier, deploy hooks, global CDN                 |
| Pipeline  | **GitHub Actions**     | Cron every few hours, smart diff, zero manual steps |

### Data files

```
data/
  players.json      # players: discordNick, chesscomNick, rating, group
  tournament.json   # games: who–who, result, when
```

Everything lives in the repo. Every refresh is a timestamped commit. Git history = tournament history. Completely unnecessary, completely satisfying.

### Pipeline

Every few hours GitHub Actions runs scripts that query the chess.com API for new games. If nothing changed — no commit, no deploy, no Cloudflare build burned. If something changed — commit, push, Cloudflare builds the site in a few seconds.

```
pnpm run fetch    # queries chess.com, updates the JSON files
pnpm run build    # Astro generates static HTML
```

Change detection works via `git diff --staged --quiet` — empty diff means no commit. Simple and effective.

### Pages

- `/` — main view, tournament progress
- `/wyniki` — standings table split by group
- `/gracze` — player list with links to profiles
- `/players/[id]` — player profile: completed matches with scores, individual game pills, list of remaining opponents

---

## Who is this for

A few dozen people playing chess on Discord who want to know if Marek has already played Piotr and what the result was. The technology is slightly oversized for the job. But at least it works.

---

_Cebularz is a traditional Lublin flatbread topped with onion and poppy seeds. Chess is a board game. The connection is obvious._
