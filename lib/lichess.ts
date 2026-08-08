/**
 * Lichess public API client. Vendored from `@edopi/chess/src/lichess.ts` — same reasons and same
 * rules as `chesscom.ts`: signatures kept identical so the two codebases stay diffable.
 *
 * Local additions, to be mirrored upstream:
 *  - `findLichessGames` — ALL candidates for a pair (claim-dedup); `findLichessGame` is a
 *    one-liner over it;
 *  - `fetchLichessProfile` — perf-aware profile+rating lookup for the `tourney` CLI.
 *
 * Dropped: `fetchLichessStats` (rapid-hardcoded, superseded by `fetchLichessProfile`) and the
 * `rated=true` query parameter — see `findLichessGames`.
 */
import { getJson, type PlayerProfile } from "./platform";

/** lichess perf keys, as they appear under `perfs` in the user payload. */
export const LICHESS_PERFS = ["rapid", "blitz", "bullet", "classical", "correspondence"] as const;

/** Lichess game summary from /api/games/user (one NDJSON line). */
export type LichessGameSummary = { id: string; [k: string]: unknown };

/** Lichess full game from /api/game/{id}. */
export type LichessGame = {
  id: string;
  createdAt: number;
  lastMoveAt?: number;
  status: string;
  winner?: "white" | "black" | null;
  url?: string;
  players: {
    white: { userId?: string; rating?: number; ratingDiff?: number };
    black: { userId?: string; rating?: number; ratingDiff?: number };
  };
};

/**
 * Statuses that aren't a real result. Upstream lists only the two dead ones (`aborted`, `noStart`);
 * `created` and `started` are added here because a game still in progress has no `winner`, and
 * "no winner" is indistinguishable from a draw — an ongoing game would be announced as ½-½.
 */
export const SKIP_STATUS = new Set(["aborted", "noStart", "created", "started"]);

export type FindGameResult =
  | { status: "found"; game: LichessGameSummary }
  | { status: "not_found" }
  | { status: "rate_limited"; retryAfterMs: number };

export type FindGamesResult =
  | { status: "ok"; games: LichessGameSummary[] }
  | { status: "rate_limited"; retryAfterMs: number };

/**
 * Profile + rating for one nick, in the perf the tournament is played at. One call covers
 * identity, real name and every perf; `username` already carries the display casing (`id` is the
 * lowercased form). The API exposes no avatar URL, so `avatar` is always absent here.
 *
 * `null` means the platform has no such player — including a CLOSED account, which answers 200
 * with a near-empty body rather than 404 (confirmed against the live API).
 */
export async function fetchLichessProfile(nick: string, perf: string): Promise<PlayerProfile | null> {
  const user = await getJson(
    `https://lichess.org/api/user/${encodeURIComponent(nick.trim())}`,
    { Accept: "application/json" }
  );
  if (!user) return null;
  if (user.closed === true) return null;

  const out: PlayerProfile = { nick: user.username || user.id || nick };
  const realName = user.profile?.realName;
  if (typeof realName === "string" && realName.trim()) out.name = realName.trim();
  const rating = user.perfs?.[perf]?.rating;
  if (typeof rating === "number") out.rating = rating;

  return out;
}

/**
 * EVERY finished game between two players in [sinceMs, untilMs], oldest first (`sort=dateAsc`,
 * since the claim order has to be reproducible). `perfType` filters on the time class when given.
 * Unfinished and aborted games are skipped: they are not a result.
 *
 * **No `rated=true`, unlike upstream.** The live league is played as unrated challenges, so the
 * upstream filter would find nothing at all. Same reasoning as `findChesscomGames`.
 */
export async function findLichessGames(
  whiteNick: string,
  blackNick: string,
  sinceMs: number,
  untilMs: number,
  perfType?: string
): Promise<FindGamesResult> {
  const url = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(whiteNick)}`);
  url.searchParams.set("vs", blackNick);
  url.searchParams.set("since", String(sinceMs));
  url.searchParams.set("until", String(untilMs));
  if (perfType) url.searchParams.set("perfType", perfType);
  url.searchParams.set("sort", "dateAsc"); // oldest first: the claim order must be deterministic
  url.searchParams.set("max", "10");

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: { Accept: "application/x-ndjson" } });
  } catch {
    return { status: "ok", games: [] };
  }

  if (res.status === 429) {
    const retryAfterSec = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    return { status: "rate_limited", retryAfterMs: retryAfterSec * 1000 };
  }
  if (!res.ok) return { status: "ok", games: [] };

  const text = await res.text();
  const games: LichessGameSummary[] = [];
  for (const line of text.trim().split("\n").filter(Boolean)) {
    try {
      const g = JSON.parse(line) as LichessGameSummary & { status?: string };
      if (g.status && SKIP_STATUS.has(g.status)) continue;
      games.push(g);
    } catch {
      continue;
    }
  }
  return { status: "ok", games };
}

/** The first game between two players in the window — `findLichessGames`, oldest candidate. */
export async function findLichessGame(
  whiteNick: string,
  blackNick: string,
  sinceMs: number,
  untilMs: number,
  perfType?: string
): Promise<FindGameResult> {
  const r = await findLichessGames(whiteNick, blackNick, sinceMs, untilMs, perfType);
  if (r.status === "rate_limited") return r;
  return r.games.length ? { status: "found", game: r.games[0] } : { status: "not_found" };
}

/** Fetches a full game by id (for the result + who actually had which colour). */
export async function fetchLichessGame(gameId: string): Promise<LichessGame | null> {
  let res: Response;
  try {
    res = await fetch(`https://lichess.org/api/game/${gameId}`, { headers: { Accept: "application/json" } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return (await res.json()) as LichessGame;
}
