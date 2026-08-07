/**
 * Standings, derived at build time from a manifest. Pure — no I/O, no network.
 *
 * Scoring is per PAIRING, not per match: `result` is always expressed in the pairing's own
 * orientation (the cron flips it when the players took the opposite colours), so the row's
 * `white` always scores the left-hand side of the result.
 *
 * A bye (`black: null`) is worth a full point ("pauza") and is not counted as a game played.
 *
 * For a double round-robin this is already correct: a pair is declared as two pairings, one per
 * colour, so per-game points sum to the same total as per-match scoring. Only the "match 2-0"
 * presentation is missing — see the notes doc.
 */
import type { Score, Tournament } from "./manifest";

export const BYE_POINTS = 1;

export interface Standing {
  place: number;
  nick: string;
  points: number;
  /** Resolved pairings with a real opponent. Byes are excluded. */
  games: number;
  byes: number;
  /** Sum of opponents' points. Byes contribute 0. */
  buchholz: number;
}

/** Points scored by the pairing's white player. Black scores `1 - this`. */
export function whitePoints(result: Score): number {
  return result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
}

/**
 * Every nick in the tournament, in the casing the manifest declares.
 * Prefers the explicit `players[]` roster; falls back to whoever appears in the pairings, so
 * hand-written manifests without a roster still render.
 */
export function rosterOf(t: Tournament): string[] {
  if (t.players?.length) return t.players.map((p) => p.nick);

  const seen = new Map<string, string>(); // lowercase → first-seen casing
  for (const round of t.rounds) {
    for (const p of round.pairings) {
      for (const nick of [p.white, p.black]) {
        if (nick && !seen.has(nick.toLowerCase())) seen.set(nick.toLowerCase(), nick);
      }
    }
  }
  return [...seen.values()];
}

/** Resolved vs total pairings — the index page's progress bar. Byes count as resolved. */
export function tournamentProgress(t: Tournament): { resolved: number; total: number } {
  let resolved = 0;
  let total = 0;
  for (const round of t.rounds) {
    for (const p of round.pairings) {
      total++;
      if (p.result || p.black === null) resolved++;
    }
  }
  return { resolved, total };
}

/**
 * Completed vs declared rounds — the swiss progress bar. A round counts as complete once every
 * one of its pairings is resolved (a bye is resolved by definition); a round declared with no
 * pairings yet is not.
 */
export function roundsProgress(t: Tournament): { resolved: number; total: number } {
  let resolved = 0;
  for (const round of t.rounds) {
    if (round.pairings.length && round.pairings.every((p) => p.result || p.black === null))
      resolved++;
  }
  return { resolved, total: t.rounds.length };
}

/**
 * Games actually played. Byes are excluded — they score, but nobody sat down to a board.
 * Round-robins show this bare count instead of a bar: their pairings are all declared up front,
 * so "N of M" would say little more than the calendar already does.
 */
export function playedGames(t: Tournament): number {
  let played = 0;
  for (const round of t.rounds) {
    for (const p of round.pairings) if (p.result && p.black !== null) played++;
  }
  return played;
}

/** Lowest and highest rating on the starting list, or null when nobody has a rating yet. */
export function ratingRange(t: Tournament): { min: number; max: number } | null {
  const ratings = (t.players ?? [])
    .map((p) => p.rating)
    .filter((r): r is number => typeof r === "number");
  if (!ratings.length) return null;
  return { min: Math.min(...ratings), max: Math.max(...ratings) };
}

/** One row of a player's profile page, in round order. */
export interface PlayerGame {
  round: number;
  board: number;
  /** The colour this player had according to the PAIRING. `null` on a bye. */
  color: "white" | "black" | null;
  /** `null` on a bye. */
  opponent: string | null;
  opponentRating?: number;
  /** This player's own score: 1 / 0.5 / 0. `null` when the game hasn't been played yet. */
  score: number | null;
  /** The pairing-oriented result, kept for the tooltip. */
  result?: Score;
  gameUrl?: string;
  colorsSwapped: boolean;
  /** A bye is "played" — it scores — but it has no game and no opponent. */
  bye: boolean;
}

/**
 * Every pairing this player appears in, oldest round first. Rounds without a pairing for them
 * are simply absent (a player can join late or sit a round out without a formal bye).
 */
export function playerGames(t: Tournament, nick: string): PlayerGame[] {
  const me = nick.toLowerCase();
  const ratings = new Map((t.players ?? []).map((p) => [p.nick.toLowerCase(), p.rating]));
  const out: PlayerGame[] = [];

  for (const round of [...t.rounds].sort((a, b) => a.round - b.round)) {
    for (const p of round.pairings) {
      const isWhite = p.white.toLowerCase() === me;
      const isBlack = p.black !== null && p.black.toLowerCase() === me;
      if (!isWhite && !isBlack) continue;

      if (p.black === null) {
        out.push({
          round: round.round,
          board: p.board,
          color: null,
          opponent: null,
          score: BYE_POINTS,
          colorsSwapped: false,
          bye: true,
        });
        continue;
      }

      const opponent = isWhite ? p.black : p.white;
      const score = p.result ? (isWhite ? whitePoints(p.result) : 1 - whitePoints(p.result)) : null;

      out.push({
        round: round.round,
        board: p.board,
        color: isWhite ? "white" : "black",
        opponent,
        opponentRating: ratings.get(opponent.toLowerCase()),
        score,
        result: p.result,
        gameUrl: p.game_url,
        colorsSwapped: p.colors_swapped === true,
        bye: false,
      });
    }
  }

  return out;
}

/** Sorted standings: points desc → Buchholz desc → nick asc (so the order is deterministic). */
export function computeStandings(t: Tournament): Standing[] {
  const roster = rosterOf(t);
  const key = (n: string) => n.toLowerCase();

  const points = new Map<string, number>();
  const games = new Map<string, number>();
  const byes = new Map<string, number>();
  const opponents = new Map<string, string[]>();

  for (const nick of roster) {
    points.set(key(nick), 0);
    games.set(key(nick), 0);
    byes.set(key(nick), 0);
    opponents.set(key(nick), []);
  }

  // A nick can appear in a pairing without being on the roster (hand-edited manifest) — count it.
  const ensure = (nick: string) => {
    const k = key(nick);
    if (!points.has(k)) {
      points.set(k, 0);
      games.set(k, 0);
      byes.set(k, 0);
      opponents.set(k, []);
      roster.push(nick);
    }
    return k;
  };

  for (const round of t.rounds) {
    for (const p of round.pairings) {
      const w = ensure(p.white);

      if (p.black === null) {
        points.set(w, points.get(w)! + BYE_POINTS);
        byes.set(w, byes.get(w)! + 1);
        continue;
      }

      const b = ensure(p.black);
      if (!p.result) continue; // pending — scores nothing for either side

      const wp = whitePoints(p.result);
      points.set(w, points.get(w)! + wp);
      points.set(b, points.get(b)! + (1 - wp));
      games.set(w, games.get(w)! + 1);
      games.set(b, games.get(b)! + 1);
      opponents.get(w)!.push(b);
      opponents.get(b)!.push(w);
    }
  }

  const rows: Standing[] = roster.map((nick) => {
    const k = key(nick);
    return {
      place: 0,
      nick,
      points: points.get(k)!,
      games: games.get(k)!,
      byes: byes.get(k)!,
      buchholz: opponents.get(k)!.reduce((sum, o) => sum + (points.get(o) ?? 0), 0),
    };
  });

  rows.sort(
    (a, b) =>
      b.points - a.points ||
      b.buchholz - a.buchholz ||
      a.nick.toLowerCase().localeCompare(b.nick.toLowerCase())
  );
  rows.forEach((r, i) => (r.place = i + 1));
  return rows;
}
