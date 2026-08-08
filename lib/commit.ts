/**
 * The cron's commit message.
 *
 * Upstream keeps this inside `cron.ts` and its body is one line per announced game. Ours adds
 * **when the game actually finished**, in UTC, because the commit log is the only place that datum
 * can accumulate for free: the manifest stores `updated_at` (when the cron noticed) and nothing
 * about when the game ended, while both platforms hand it to us and we would otherwise drop it.
 *
 * Deliberately raw — an ISO instant, no local time, no bucketing, no aggregation. Whatever question
 * gets asked of this later (hour of day, day of week, gap between finish and announcement) is a
 * question for the analysis, not for the writer. Timestamps are cheap to reinterpret and impossible
 * to recover once rounded off.
 */
import type { Score } from "./manifest";

export interface PostedGame {
  round: number;
  board: number;
  white: string;
  black: string;
  result: Score;
  /** When the game FINISHED (ISO), per the platform — not when the cron saw it. */
  endedAt?: string;
}

/**
 * `played 2026-08-09T08:39:00Z` — the platform's end time, seconds precision, milliseconds
 * dropped as noise. Returns "" when there is no usable timestamp, so the line degrades to the
 * plain upstream form instead of printing something invented.
 */
export function formatPlayedAt(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `played ${d.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

/**
 * Title names the latest round announced; body lists each game with when it was played. No
 * timestamp of its own — the commit date and the Actions run time already carry that. Round order
 * follows fetch order (no sorting), so the body reads in the order things were announced.
 */
export function buildCommitMessage(posted: PostedGame[]): string {
  if (posted.length === 0) return "notify: sync round files"; // ingest-only change, no new results
  const lastRound = Math.max(...posted.map((g) => g.round));
  const games = posted
    .map((g) => {
      const when = formatPlayedAt(g.endedAt);
      return ` ✅ r${g.round}#${g.board} ${g.white} vs ${g.black} ${g.result}${when ? ` — ${when}` : ""}`;
    })
    .join("\n");
  return `notify: game results from ${lastRound} round\n\nGames\n${games}`;
}
