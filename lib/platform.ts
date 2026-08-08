/**
 * Shared plumbing for the two playzone clients (`chesscom.ts`, `lichess.ts`).
 *
 * This file has NO upstream counterpart. `@edopi/chess` swallows every transport error and
 * returns null/[] — fine for a cron that will simply retry in six hours, wrong for the `tourney`
 * CLI, where "the API is down" and "no such player" must be distinguishable (exit 2 vs exit 1).
 * So the loud path lives here, and the two clients use whichever style each call needs:
 * `getJson` (throws) for CLI lookups, plain `fetch` for the cron's game discovery.
 */

/** Sent on every chess.com request — the API rejects callers that don't identify themselves. */
export const USER_AGENT = "cebuliga-tourney/1.0 (+https://github.com/pnowosie)";

/** Courtesy gap between consecutive lookups. Lichess asks for ~1 req/s; chess.com is laxer. */
export const THROTTLE_MS = 400;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** GET returning parsed JSON, `null` on 404, throwing on anything else. */
export async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
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
