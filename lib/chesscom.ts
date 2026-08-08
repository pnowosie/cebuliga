/**
 * Chess.com public API client. Vendored from `@edopi/chess/src/chesscom.ts` — the package lives on
 * a private Forgejo registry this repo cannot reach, so the code is copied and the signatures kept
 * identical, function for function, so the two codebases stay diffable.
 *
 * Local additions, both to be mirrored upstream (see notes/tournament-infopage-rewrite.md):
 *  - `findChesscomGames` — ALL candidate games for a pair, which claim-dedup needs.
 *    `findChesscomGame` is now a one-liner over it, so upstream call sites are unaffected.
 *  - `fetchChesscomProfile` — perf-aware profile+rating lookup for the `tourney` CLI
 *    (upstream's `fetchChesscomStats` is hardcoded to `chess_rapid`).
 *
 * Dropped deliberately, so a diff against upstream is explainable:
 *  - the `g.rated === false` skip — see `findChesscomGames`;
 *  - `fetchRapidRating` / `fetchChesscomStats` — rapid-hardcoded, superseded by
 *    `fetchChesscomProfile`. Keeping them would leave two chess.com clients in one repo;
 *  - `fetchGameById` / `computeRatingChange` / `countMoves` — rating history and move counts are
 *    out of scope here (the site stores rating as a sort key, not a series).
 */
import { USER_AGENT, getJson, type PlayerProfile } from "./platform";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChessComGamePlayer {
  username: string;
  rating: number;
  result: string;
  "@id"?: string;
  uuid?: string;
}

export interface ChessComGame {
  uuid: string;
  url: string;
  time_class: string;
  time_control: string;
  end_time: number; // unix seconds
  rated?: boolean;
  white: ChessComGamePlayer;
  black: ChessComGamePlayer;
  pgn?: string;
  accuracies?: { white: number; black: number };
  eco?: string;
  fen?: string;
}

/** chess.com perf keys, as they appear in `/stats` (prefixed `chess_`). */
export const CHESSCOM_PERFS = ["rapid", "blitz", "bullet", "daily"] as const;

// ─── PGN utilities ────────────────────────────────────────────────────────────

/** Extracts the value of a PGN header tag, e.g. [Termination "ppm2019 won by checkmate"]. */
export function parsePgnHeader(pgn: string, key: string): string | null {
  const match = pgn.match(new RegExp(`\\[${key} "([^"]*)"`));
  return match ? match[1] : null;
}

/** Human-readable termination string from the PGN, e.g. "Game drawn by repetition". */
export function parseTermination(pgn: string): string | null {
  return parsePgnHeader(pgn, "Termination");
}

/** Short termination label derived from the players' result fields (no PGN needed). */
export function terminationLabel(game: ChessComGame): string {
  const draws = new Set([
    "stalemate", "insufficient", "50move", "repetition", "agreed", "timevsinsufficient",
  ]);
  const whiteResult = game.white.result;
  const blackResult = game.black.result;

  if (draws.has(whiteResult) || draws.has(blackResult)) {
    const cause = draws.has(whiteResult) ? whiteResult : blackResult;
    const labels: Record<string, string> = {
      stalemate: "stalemate",
      insufficient: "insufficient material",
      "50move": "50-move rule",
      repetition: "repetition",
      agreed: "agreement",
      timevsinsufficient: "time vs insufficient",
    };
    return `draw (${labels[cause] ?? cause})`;
  }

  const loserResult = whiteResult === "win" ? blackResult : whiteResult;
  const labels: Record<string, string> = {
    checkmated: "checkmate",
    resigned: "resignation",
    timeout: "timeout",
    abandoned: "abandoned",
  };
  return labels[loserResult] ?? loserResult;
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

export type MonthFetch = { games: ChessComGame[]; rateLimited: boolean };

/**
 * Fetches a player's games for one month from chess.com.
 * Signals rate limiting (HTTP 429) so callers can back off; other errors yield [].
 *
 * The path is lowercased: `/pub/player/Jasio_2006` answers 301 with an error body pointing at the
 * lowercase URL (confirmed against the live API), so mixed casing costs a whole month of games.
 */
export async function fetchPlayerMonthGames(
  username: string,
  year: number,
  month: number
): Promise<MonthFetch> {
  const mm = String(month).padStart(2, "0");
  const nick = encodeURIComponent(username.trim().toLowerCase());
  const url = `https://api.chess.com/pub/player/${nick}/games/${year}/${mm}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  } catch {
    return { games: [], rateLimited: false };
  }
  if (res.status === 429) return { games: [], rateLimited: true };
  if (!res.ok) return { games: [], rateLimited: false };
  const data = (await res.json()) as { games?: ChessComGame[] };
  return { games: data.games ?? [], rateLimited: false };
}

/**
 * Profile + rating for one nick, in the perf the tournament is played at.
 *
 * Two calls, because chess.com splits identity from ratings. Two casing rules, both confirmed
 * against the live API: the REQUEST path must be lowercase, and the DISPLAY casing lives in `.url`
 * (`https://www.chess.com/member/Jasio_2006`) — `.username` is lowercased.
 *
 * `null` means the platform has no such player; a transport failure throws `PlatformError`.
 */
export async function fetchChesscomProfile(nick: string, perf: string): Promise<PlayerProfile | null> {
  const key = encodeURIComponent(nick.trim().toLowerCase());
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };

  const profile = await getJson(`https://api.chess.com/pub/player/${key}`, headers);
  if (!profile) return null;

  const fromUrl = typeof profile.url === "string" ? profile.url.split("/").filter(Boolean).pop() : null;
  const out: PlayerProfile = { nick: fromUrl || profile.username || nick };
  if (typeof profile.name === "string" && profile.name.trim()) out.name = profile.name.trim();
  if (typeof profile.avatar === "string" && profile.avatar) out.avatar = profile.avatar;

  const stats = await getJson(`https://api.chess.com/pub/player/${key}/stats`, headers);
  const rating = stats?.[`chess_${perf}`]?.last?.rating;
  if (typeof rating === "number") out.rating = rating;

  return out;
}

// ─── Game discovery ─────────────────────────────────────────────────────────

export type FindChessComGameResult =
  | { status: "found"; game: ChessComGame }
  | { status: "not_found" }
  | { status: "rate_limited"; retryAfterMs: number };

export type FindChessComGamesResult =
  | { status: "ok"; games: ChessComGame[] }
  | { status: "rate_limited"; retryAfterMs: number };

/**
 * EVERY finished game between two players in [sinceMs, untilMs], oldest first. A colour swap
 * between the two known players still counts. `perfType` filters on the time CLASS ("rapid") when
 * given; omit to accept any.
 *
 * Plural because one game per pair is not the general case: a double round-robin declares two
 * pairings for the same pair (one per colour) with the same search window, so the caller has to
 * see all candidates and decide which pairing claims which game. Singular callers get the first.
 *
 * **No `rated` filter, unlike upstream.** Upstream skips `rated === false`, which would make this
 * cron blind to the live league: ChessManager events are routinely played as unrated challenges,
 * and `marian-rapid-202608` is one. The pairing, the time class and the round window are the
 * filters that matter; "rated" says nothing about whether a game is the tournament's.
 */
export async function findChesscomGames(
  whiteNick: string,
  blackNick: string,
  sinceMs: number,
  untilMs: number,
  perfType?: string,
  cache?: Map<string, ChessComGame[]>
): Promise<FindChessComGamesResult> {
  const sinceSec = Math.floor(sinceMs / 1000);
  const untilSec = Math.ceil(untilMs / 1000);
  const w = whiteNick.toLowerCase();
  const b = blackNick.toLowerCase();

  const start = new Date(sinceMs);
  const end = new Date(untilMs);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth() + 1;

  const found: ChessComGame[] = [];

  while (y < endY || (y === endY && m <= endM)) {
    const key = `${w}:${y}:${m}`;
    let games: ChessComGame[] | undefined = cache?.get(key);
    if (!games) {
      const res = await fetchPlayerMonthGames(whiteNick, y, m);
      if (res.rateLimited) return { status: "rate_limited", retryAfterMs: 60_000 };
      games = res.games;
      cache?.set(key, games);
    }

    for (const g of games) {
      if (g.end_time < sinceSec || g.end_time > untilSec) continue;
      if (perfType && g.time_class !== perfType) continue;
      const wu = g.white.username.toLowerCase();
      const bu = g.black.username.toLowerCase();
      if ((wu === w && bu === b) || (wu === b && bu === w)) found.push(g);
    }

    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  // Archives are chronological per month and months ascend, but sort anyway: the order decides
  // which pairing claims which game when a pair played twice in one window.
  found.sort((a, b2) => a.end_time - b2.end_time);
  return { status: "ok", games: found };
}

/** The first game between two players in the window — `findChesscomGames`, oldest candidate. */
export async function findChesscomGame(
  whiteNick: string,
  blackNick: string,
  sinceMs: number,
  untilMs: number,
  perfType?: string,
  cache?: Map<string, ChessComGame[]>
): Promise<FindChessComGameResult> {
  const r = await findChesscomGames(whiteNick, blackNick, sinceMs, untilMs, perfType, cache);
  if (r.status === "rate_limited") return r;
  return r.games.length ? { status: "found", game: r.games[0] } : { status: "not_found" };
}

/** Score from chess.com result fields. */
export function chesscomScore(g: ChessComGame): "1-0" | "0-1" | "½-½" {
  if (g.white.result === "win") return "1-0";
  if (g.black.result === "win") return "0-1";
  return "½-½";
}

/** Stable game id from a chess.com game (uuid, else the url tail). */
export function chesscomGameId(g: ChessComGame): string {
  if (g.uuid) return g.uuid;
  const tail = g.url.split("/").filter(Boolean).pop();
  return tail ?? g.url;
}
