/**
 * Round-robin schedule generation. Pure: nicks in, rounds out. No I/O, no manifest, no clock —
 * which is what makes it the one part of `tourney` worth unit-testing properly.
 *
 * Circle method: player 0 is the anchor, everyone else rotates one seat per round, and each
 * round pairs seat i against seat n-1-i. An odd field gets a phantom opponent whose pairings
 * become byes (`black: null`).
 *
 * Colours: only the ANCHOR'S board flips, and only on odd rounds. Left alone, the circle method
 * hands the anchor the same colour in every round; alternating just that one board propagates
 * through the rotation and balances everyone. Measured, not assumed — an odd field comes out
 * exactly even and an even field within one game (unavoidable: n-1 games is odd). Rules that
 * look more symmetrical, such as flipping on `(round + board)` parity, are *catastrophically*
 * worse — they give the anchor every white — which is why the tests assert the balance.
 *
 * SEEDING IS THE CALLER'S ORDER. `players[]` in the manifest is the draw: reorder that array and
 * you get a different schedule, deterministically. Nothing is shuffled here.
 */

/** A pairing before it acquires a result. `black: null` is a bye ("pauza"). */
export interface GeneratedPairing {
  board: number;
  white: string;
  black: string | null;
}

/** A seat at the table. `null` is the phantom an odd field needs; it becomes `black: null`. */
type Seat = string | null;

/**
 * One full cycle: `n-1` rounds for an even field, `n` for an odd one (each player sits out once).
 * Returns rounds in order, each with boards numbered from 1, byes last.
 */
function cycle(players: string[]): GeneratedPairing[][] {
  const seats: Seat[] = [...players];
  if (seats.length % 2 === 1) seats.push(null);

  const n = seats.length;
  const rounds: GeneratedPairing[][] = [];
  let rotation = [...seats];

  for (let r = 0; r < n - 1; r++) {
    const real: GeneratedPairing[] = [];
    const byes: GeneratedPairing[] = [];

    for (let i = 0; i < n / 2; i++) {
      let a = rotation[i];
      let b = rotation[n - 1 - i];
      if (i === 0 && r % 2 === 1) [a, b] = [b, a];

      if (a === null || b === null) {
        // The real player always takes the `white` slot; a bye has no second side.
        byes.push({ board: 0, white: (a ?? b) as string, black: null });
      } else {
        real.push({ board: 0, white: a, black: b });
      }
    }

    // Byes sort last, as ChessManager prints them, then boards number sequentially.
    rounds.push([...real, ...byes].map((p, i) => ({ ...p, board: i + 1 })));

    // Rotate every seat but the anchor: last seat moves to the front of the rotating block.
    rotation = [rotation[0], rotation[n - 1], ...rotation.slice(1, n - 1)];
  }

  return rounds;
}

/**
 * The whole schedule. A double round-robin appends a second cycle with every colour reversed —
 * which is exactly the "two pairings per pair, one per colour" shape the cron's claim-dedup
 * expects in phase 3.
 *
 * Throws below two players: there is no schedule to generate, and silently returning `[]` would
 * look like success.
 */
export function bergerSchedule(players: string[], double = false): GeneratedPairing[][] {
  if (players.length < 2) {
    throw new Error(`need at least 2 players to generate a schedule, got ${players.length}`);
  }

  const dupes = findDuplicates(players);
  if (dupes.length) {
    throw new Error(`duplicate players in the roster: ${dupes.join(", ")}`);
  }

  const first = cycle(players);
  if (!double) return first;

  const second = first.map((round) =>
    round.map((p) =>
      p.black === null ? { ...p } : { board: p.board, white: p.black, black: p.white }
    )
  );
  return [...first, ...second];
}

/** Case-insensitive, because every nick comparison in this codebase is. */
function findDuplicates(players: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of players) {
    const k = p.toLowerCase();
    if (seen.has(k)) dupes.add(p);
    seen.add(k);
  }
  return [...dupes];
}
