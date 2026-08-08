/**
 * The vendored `@edopi/chess`: chess.com + lichess clients, plus the platform-agnostic layer the
 * `tourney` CLI talks to. Import this rather than the platform files when the platform is a value
 * (`t.platform`) rather than a compile-time choice.
 *
 * `lib/profile.ts` and the old dead `lib/chess.ts` were folded in here; there is exactly one
 * chess.com client and one lichess client in this repo.
 */
export * from "./platform";
export * from "./chesscom";
export * from "./lichess";

import type { Tournament } from "./manifest";
import { CHESSCOM_PERFS, fetchChesscomProfile } from "./chesscom";
import { LICHESS_PERFS, fetchLichessProfile } from "./lichess";
import { PlatformError, type PlayerProfile } from "./platform";

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

/** Looks a nick up on the tournament's platform. `null` means the platform has no such player. */
export function fetchProfile(
  platform: Tournament["platform"],
  nick: string,
  perf: string
): Promise<PlayerProfile | null> {
  return platform === "lichess" ? fetchLichessProfile(nick, perf) : fetchChesscomProfile(nick, perf);
}
