/**
 * Player lookup on the playzones, for the `tourney` CLI. Answers one question: "does this nick
 * exist, and what does the platform say about it right now?"
 *
 * Deliberately NOT in `lib/chess.ts` — that file is dead code awaiting phase 3, which vendors
 * `@edopi/chess` wholesale and will absorb these functions. Upstream's `fetchChesscomStats` /
 * `fetchLichessStats` are rapid-hardcoded (`chess_rapid`, `perfs.rapid`); ours are perf-aware,
 * because the manifest's `timeControl` decides which rating is the relevant one.
 *
 * Everything here is optional-tolerant: `name` and `avatar` are absent for most accounts, and
 * their absence is never an error. Only "the nick does not exist" is a negative result.
 */
import type { Tournament } from "./manifest";

/** Sent on every chess.com request — the API rejects callers that don't identify themselves. */
const USER_AGENT = "cebuliga-tourney/1.0 (+https://github.com/pnowosie)";

/** Courtesy gap between consecutive lookups. Lichess asks for ~1 req/s; chess.com is laxer. */
export const THROTTLE_MS = 400;

/** What a playzone tells us about a nick. `nick` is the platform's own casing, not the input. */
export interface PlayerProfile {
  nick: string;
  name?: string;
  rating?: number;
  avatar?: string;
}

/** Thrown for transport-level failures (5xx, 429, DNS). NOT for "no such player" — that's null. */
export class PlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

const CHESSCOM_PERFS = ["rapid", "blitz", "bullet", "daily"] as const;
const LICHESS_PERFS = ["rapid", "blitz", "bullet", "classical", "correspondence"] as const;

/**
 * The manifest's `timeControl` as a perf key the platform recognises.
 *
 * Throws rather than silently returning no rating: a typo'd or cross-platform perf ("classical"
 * on chess.com) is a manifest bug, and a whole roster quietly missing its ratings is a much
 * worse outcome than a loud error at `add` time.
 */
export function perfKey(platform: Tournament["platform"], timeControl: string): string {
  const perf = timeControl.trim().toLowerCase();
  const allowed: readonly string[] = platform === "lichess" ? LICHESS_PERFS : CHESSCOM_PERFS;
  if (!allowed.includes(perf)) {
    throw new PlatformError(
      `timeControl "${timeControl}" is not a ${platform} perf (expected one of: ${allowed.join(", ")})`
    );
  }
  return perf;
}

/** GET returning parsed JSON, `null` on 404, throwing on anything else. */
async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: "manual" });
  } catch (e) {
    throw new PlatformError(`${url}: ${(e as Error).message}`);
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new PlatformError(`${url}: rate limited (429) — wait and retry`);
  if (!res.ok) throw new PlatformError(`${url}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new PlatformError(`${url}: response was not JSON`);
  }
}

/**
 * chess.com. Two calls: the profile (identity, name, avatar) and the stats (rating).
 *
 * Two casing rules, both confirmed against the live API:
 *  - the REQUEST path must be lowercase. `/pub/player/Jasio_2006` answers 301 with an error body
 *    pointing at the lowercase URL; only `/pub/player/jasio_2006` returns the player.
 *  - the DISPLAY casing lives in `.url` (`https://www.chess.com/member/Jasio_2006`). `.username`
 *    is lowercased and is NOT what the player sees on their own profile.
 */
async function fetchChesscom(nick: string, perf: string): Promise<PlayerProfile | null> {
  const key = nick.trim().toLowerCase();
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };

  const profile = await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(key)}`, headers);
  if (!profile) return null;

  const fromUrl = typeof profile.url === "string" ? profile.url.split("/").filter(Boolean).pop() : null;
  const out: PlayerProfile = { nick: fromUrl || profile.username || nick };
  if (typeof profile.name === "string" && profile.name.trim()) out.name = profile.name.trim();
  if (typeof profile.avatar === "string" && profile.avatar) out.avatar = profile.avatar;

  const stats = await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(key)}/stats`, headers);
  const rating = stats?.[`chess_${perf}`]?.last?.rating;
  if (typeof rating === "number") out.rating = rating;

  return out;
}

/**
 * lichess. One call covers identity, real name and every perf rating.
 * `username` already carries the display casing (`id` is the lowercased form).
 * The API exposes no avatar URL, so `avatar` is always absent here.
 */
async function fetchLichess(nick: string, perf: string): Promise<PlayerProfile | null> {
  const user = await getJson(
    `https://lichess.org/api/user/${encodeURIComponent(nick.trim())}`,
    { Accept: "application/json" }
  );
  if (!user) return null;
  // A closed account answers 200 with a near-empty body; treat it as "no such player".
  if (user.closed === true) return null;

  const out: PlayerProfile = { nick: user.username || user.id || nick };
  const realName = user.profile?.realName;
  if (typeof realName === "string" && realName.trim()) out.name = realName.trim();
  const rating = user.perfs?.[perf]?.rating;
  if (typeof rating === "number") out.rating = rating;

  return out;
}

/** Looks a nick up on the tournament's platform. `null` means the platform has no such player. */
export function fetchProfile(
  platform: Tournament["platform"],
  nick: string,
  perf: string
): Promise<PlayerProfile | null> {
  return platform === "lichess" ? fetchLichess(nick, perf) : fetchChesscom(nick, perf);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
