/**
 * Walkowery for blocked accounts — the regulation's "🚩 Fair play" rule, as data.
 *
 * > Jeśli na profilu zawodnika pojawi się komunikat o naruszeniu zasad platformy, oznacza to
 * > przegraną i wykluczenie z turnieju — niezależnie od przyczyny komunikatu.
 *
 * Kept 1-1 with `org/game-notifier/src/lib/forfeit.ts`, with one deliberate difference: DETECTION
 * lives upstream. `tourney refresh` there probes the playzone and writes `Tournament.blocked`;
 * this repo never does, and has no `clearBlockade`. What is mirrored is the pure part — the site
 * needs `pairingPoints`/`isBlocked` to render, and the cron needs `applyBlockades`/`isSettled` to
 * keep its hands off a walkower.
 *
 * The load-bearing decision: a forfeit does NOT overwrite `result`. Round 1 board 6 of the live
 * league is `f0rk1ngtal` vs `TomasK14` stored as `0-1` — TomasK14 WON, and that result was already
 * announced on Discord. Overwriting it would leave the channel permanently contradicting the site,
 * would invent a result with no game URL on boards nobody played, and still could not express the
 * 0-0 two blocked players deserve, since `Score` has three values. So `forfeit` overrides `result`
 * for scoring and leaves the record of the played game intact — which is also what lets the page
 * show "walkower, ale rozegrano 0-1".
 */
import type { Pairing, Score, Tournament } from "./manifest";

/** Points scored by the pairing's white player from a played result. Black scores `1 - this`. */
export function whitePoints(result: Score): number {
  return result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
}

/** Is this nick blocked in this tournament? Case-insensitive: `blocked` is keyed lowercase. */
export function isBlocked(t: Tournament, nick: string | null | undefined): boolean {
  if (!nick) return false;
  return t.blocked?.[nick.toLowerCase()] !== undefined;
}

/** The blockade record for a nick, for rendering the reason and the detection date. */
export function blockOf(t: Tournament, nick: string | null | undefined) {
  if (!nick) return undefined;
  return t.blocked?.[nick.toLowerCase()];
}

/**
 * What a pairing is worth to each side. THE way to score a pairing — reading `result` directly
 * silently ignores walkowery. `null` means nothing has been decided yet.
 *
 * A bye is not a pairing in this sense (it has no `black`) and is scored by the caller.
 */
export function pairingPoints(p: Pairing): { white: number; black: number } | null {
  if (p.forfeit === "white") return { white: 0, black: 1 };
  if (p.forfeit === "black") return { white: 1, black: 0 };
  if (p.forfeit === "both") return { white: 0, black: 0 };
  if (!p.result) return null;
  const w = whitePoints(p.result);
  return { white: w, black: 1 - w };
}

/** Is this pairing settled — by a played game or by the regulation? The cron's dedup question. */
export function isSettled(p: Pairing): boolean {
  return p.result !== undefined || p.forfeit !== undefined;
}

/**
 * Stamps `forfeit` on every pairing involving a blocked player. Returns true if anything changed.
 *
 * Here this is purely DEFENSIVE, and it is why the cron can be trusted with a manifest copied down
 * from game-notifier: this repo's cron ingests round files too, so a round pasted after a blockade
 * would otherwise arrive unforfeited and send discovery hunting for a withdrawn player's games.
 * Additive only — a blockade is permanent, and un-blocking is an upstream `tourney unblock`.
 *
 * Idempotent, pure, no network. Must run after `syncRounds` and before discovery.
 */
export function applyBlockades(t: Tournament): boolean {
  if (!t.blocked || Object.keys(t.blocked).length === 0) return false;

  let changed = false;
  for (const round of t.rounds) {
    for (const p of round.pairings) {
      if (p.black === null) continue; // a bye has no opponent to award the point to

      const w = isBlocked(t, p.white);
      const b = isBlocked(t, p.black);
      if (!w && !b) continue;

      const next = w && b ? "both" : w ? "white" : "black";
      if (p.forfeit !== next) {
        p.forfeit = next;
        changed = true;
      }
    }
  }
  return changed;
}
