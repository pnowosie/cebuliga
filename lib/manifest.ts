/**
 * Tournament manifests = the shared data format (committed to the repo, read by both the
 * cron and the site at build time). One `tournaments/<slug>.json` per tournament; swiss round
 * pairings are dropped as `tournaments/<slug>/r<N>.txt` (ChessManager paste) and ingested into
 * `rounds[]` on first sight.
 *
 * Kept 1-1 with `org/game-notifier/src/lib/manifest.ts` — same type names, same function
 * signatures — so the two codebases can be diffed. Two deliberate differences:
 *   - node `execFileSync` instead of bun's `$` (this repo runs on node/tsx, not bun);
 *   - imports have no `.ts` suffix (upstream uses them; Astro/Vite resolves either way).
 *
 * Local extensions, all mirrored back upstream: `Player`, `Tournament.players`,
 * `Tournament.clockInfo`, `Tournament.plannedRounds`, `Pairing.colors_swapped`, and
 * `"double-round-robin"` in `Tournament.type`.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parsePairingsPaste } from "./pairings";

const DAY_MS = 86_400_000;

export type Score = "1-0" | "0-1" | "½-½";

/** A player is ONLY a nick on the tournament's platform. There is no person behind it. */
export interface Player {
  nick: string;
  /** Display name from the playzone profile, when the player has set one. Decorative only —
   *  the nick remains the identifier; most players leave this empty. */
  name?: string;
  /** Rating in the tournament's `timeControl` perf, as of the last `tourney` refresh. */
  rating?: number;
  /** Profile picture URL from the platform. Stored rather than fetched, so the build stays
   *  offline; filled in by `tourney add`. Absent for players who never set one. */
  avatar?: string;
}

export interface Pairing {
  board: number;
  white: string;
  black: string | null;   // null = bye
  result?: Score;         // set once the game is found+posted (also the dedup marker)
  game_url?: string;
  updated_at?: string;
  /** The players took the opposite colours to the pairing. `result` is still expressed in
   *  PAIRING orientation (the cron flips it), so the site only needs this for the ⚠ icon.
   *  Meaningless for `type: "round-robin"`, where the playzone draws the colour. */
  colors_swapped?: boolean;
}

export interface Round {
  round: number;
  /** Round window start (ISO). The game-search window is [startDate, now] (delayed games from past
   *  rounds are still found). CRITICAL for correctness — without it, an earlier rapid game between
   *  the same two players (a previous round or a casual game) can be mis-matched as this round's. */
  startDate?: string;
  pairings: Pairing[];
}

export type TournamentType = "swiss" | "round-robin" | "double-round-robin";

export interface Tournament {
  slug: string;
  title: string;
  platform: "chesscom" | "lichess";
  type: TournamentType;
  organiser: string;
  channel: string;          // → secret <CHANNEL>_WEBHOOK
  /** Perf CLASS ("rapid" | "blitz" | …). Load-bearing: the cron filters candidate games on it
   *  and `tourney` reads ratings from the matching perf. Do not put a clock in here. */
  timeControl: string;
  /** Whatever the organiser wants shown in place of the perf class — `⌛ 10'+5"`, `📅 1 dzień`,
   *  anything. DISPLAY only, rendered verbatim (icon included, since the organiser chooses it)
   *  and never parsed. Falls back to `timeControl` when unset. */
  clockInfo?: string;
  active: boolean;
  startDate: string;        // ISO; game-search window lower bound
  endDate: string;          // ISO; window upper bound
  cmUrl?: string;
  /** Starting list. Maintained by `pnpm t add`; absent on hand-written manifests. */
  players?: Player[];
  /** How many rounds the event is scheduled to have, as announced by the organiser. Display
   *  ONLY — nothing derives pairings or windows from it. A swiss creates its rounds one paste at
   *  a time, so `rounds.length` is "how far we got", never "how long it is"; without this the
   *  site could only show `1 / 1` on the opening round. Unset ⇒ fall back to `rounds.length`. */
  plannedRounds?: number;
  rounds: Round[];
}

/** Loads every `<dir>/*.json` as a Tournament. */
export function loadTournaments(dir: string): { tournament: Tournament; file: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ tournament: JSON.parse(readFileSync(join(dir, f), "utf8")) as Tournament, file: join(dir, f) }));
}

/** The file's git commit date, or null if it isn't committed / git is unavailable. */
function fileCommitDate(file: string): Date | null {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const d = new Date(out);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Syncs declared rounds with the round files in `<dir>/<slug>/r<N>.txt`:
 *  - a file whose round isn't declared yet → AUTO-CREATE the round object, with
 *    `startDate = (file's git commit date, else now) − 1 day` (cushions the ~1-day lag between
 *    official pairings and the commit, so the round's games fall inside the search window);
 *  - a declared round with empty `pairings` → materialize them from its file.
 * Mutates `t.rounds` (sorted by round); returns true if anything changed.
 *
 * NOTE: needs full git history. A shallow CI clone makes `fileCommitDate` return null and
 * silently degrades `startDate` to "now − 1 day", which can miss already-played games.
 */
export async function syncRounds(t: Tournament, dir: string): Promise<boolean> {
  const sub = join(dir, t.slug);
  if (!existsSync(sub)) return false;

  const re = /^r(\d+)\.txt$/i; // <dir>/<slug>/ already disambiguates → no slug prefix needed
  const byRound = new Map(t.rounds.map((r) => [r.round, r]));
  let changed = false;

  for (const f of readdirSync(sub)) {
    const m = f.match(re);
    if (!m) continue;
    const round = parseInt(m[1], 10);
    const file = join(sub, f);

    let r = byRound.get(round);
    if (!r) {
      const base = fileCommitDate(file) ?? new Date();
      r = { round, startDate: new Date(base.getTime() - DAY_MS).toISOString(), pairings: [] };
      t.rounds.push(r);
      byRound.set(round, r);
      changed = true;
    }
    if (!r.pairings || r.pairings.length === 0) {
      r.pairings = parsePairingsPaste(readFileSync(file, "utf8"))
        .sort((a, b) => a.boardNumber - b.boardNumber)
        .map((p) => ({ board: p.boardNumber, white: p.white, black: p.black }));
      changed = true;
    }
  }

  if (changed) t.rounds.sort((a, b) => a.round - b.round);
  return changed;
}

/** Stable serialization (2-space, trailing newline) for clean git diffs. */
export function serialize(t: Tournament): string {
  return JSON.stringify(t, null, 2) + "\n";
}

/** Writes the manifest only if its serialization changed. Returns true if written. */
export function writeIfChanged(file: string, t: Tournament): boolean {
  const next = serialize(t);
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (next === prev) return false;
  writeFileSync(file, next);
  return true;
}
