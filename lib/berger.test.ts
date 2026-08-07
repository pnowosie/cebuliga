/**
 * The schedule generator is the one piece of `tourney` with enough combinatorics to be wrong in
 * a way nobody notices until round 4. Run with `pnpm test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bergerSchedule, type GeneratedPairing } from "./berger";

const nicks = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const flat = (rounds: GeneratedPairing[][]) => rounds.flat();
const pairKey = (p: GeneratedPairing) =>
  [p.white, p.black ?? "BYE"].map((s) => s.toLowerCase()).sort().join("|");

test("rejects a field too small to schedule", () => {
  assert.throws(() => bergerSchedule([]), /at least 2/);
  assert.throws(() => bergerSchedule(["solo"]), /at least 2/);
});

test("rejects duplicate nicks case-insensitively", () => {
  assert.throws(() => bergerSchedule(["Ann", "bob", "ANN"]), /duplicate/i);
});

test("even field: n-1 rounds, n/2 boards, no byes", () => {
  for (const n of [2, 4, 6, 8, 10]) {
    const rounds = bergerSchedule(nicks(n));
    assert.equal(rounds.length, n - 1, `${n} players`);
    for (const r of rounds) {
      assert.equal(r.length, n / 2);
      assert.ok(r.every((p) => p.black !== null), `${n} players should have no byes`);
    }
  }
});

test("odd field: n rounds, and every player sits out exactly once", () => {
  for (const n of [3, 5, 7, 9]) {
    const rounds = bergerSchedule(nicks(n));
    assert.equal(rounds.length, n, `${n} players`);

    const byes = new Map<string, number>();
    for (const r of rounds) {
      const roundByes = r.filter((p) => p.black === null);
      assert.equal(roundByes.length, 1, `${n} players: exactly one bye per round`);
      // The player on a bye always holds the `white` slot — nothing sits in `black`.
      byes.set(roundByes[0].white, (byes.get(roundByes[0].white) ?? 0) + 1);
    }
    for (const p of nicks(n)) assert.equal(byes.get(p), 1, `${p} should sit out once`);
  }
});

test("every pair meets exactly once", () => {
  for (const n of [3, 4, 5, 6, 7, 8]) {
    const played = flat(bergerSchedule(nicks(n)))
      .filter((p) => p.black !== null)
      .map(pairKey);
    assert.equal(new Set(played).size, played.length, `${n} players: no pair repeats`);
    assert.equal(played.length, (n * (n - 1)) / 2, `${n} players: all pairs covered`);
  }
});

test("nobody is scheduled twice in the same round", () => {
  for (const n of [3, 4, 5, 6, 7, 8, 9, 10]) {
    for (const round of bergerSchedule(nicks(n))) {
      const seen = new Set<string>();
      for (const p of round) {
        for (const nick of [p.white, p.black]) {
          if (!nick) continue;
          assert.ok(!seen.has(nick), `${n} players: ${nick} appears twice in one round`);
          seen.add(nick);
        }
      }
    }
  }
});

test("colours are balanced to within one game per player", () => {
  for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const white = new Map<string, number>();
    const black = new Map<string, number>();
    for (const p of flat(bergerSchedule(nicks(n)))) {
      if (p.black === null) continue; // a bye is neither colour
      white.set(p.white, (white.get(p.white) ?? 0) + 1);
      black.set(p.black, (black.get(p.black) ?? 0) + 1);
    }
    for (const p of nicks(n)) {
      const diff = Math.abs((white.get(p) ?? 0) - (black.get(p) ?? 0));
      // An odd field plays an even number of games each, so it must come out exactly even.
      // An even field plays n-1 (odd) games, where one spare colour is unavoidable.
      assert.ok(diff <= (n % 2 === 1 ? 0 : 1), `${n} players: ${p} has a colour imbalance of ${diff}`);
    }
  }
});

test("double round-robin: twice the rounds, each pair meeting once per colour", () => {
  for (const n of [3, 4, 5, 6]) {
    const single = bergerSchedule(nicks(n));
    const double = bergerSchedule(nicks(n), true);
    assert.equal(double.length, single.length * 2);

    // Each ordered (white, black) pair occurs exactly once across the whole event.
    const oriented = flat(double)
      .filter((p) => p.black !== null)
      .map((p) => `${p.white}>${p.black}`);
    assert.equal(new Set(oriented).size, oriented.length, `${n} players: no colour repeats`);
    assert.equal(oriented.length, n * (n - 1), `${n} players: every ordered pair covered`);
  }
});

test("double round-robin gives a perfectly even colour split", () => {
  for (const n of [4, 6, 8]) {
    const white = new Map<string, number>();
    const black = new Map<string, number>();
    for (const p of flat(bergerSchedule(nicks(n), true))) {
      if (p.black === null) continue;
      white.set(p.white, (white.get(p.white) ?? 0) + 1);
      black.set(p.black, (black.get(p.black) ?? 0) + 1);
    }
    for (const p of nicks(n)) assert.equal(white.get(p), black.get(p), `${p} at ${n} players`);
  }
});

test("boards number from 1 with byes last", () => {
  for (const n of [3, 4, 5, 8]) {
    for (const round of bergerSchedule(nicks(n))) {
      assert.deepEqual(
        round.map((p) => p.board),
        round.map((_, i) => i + 1)
      );
      const firstBye = round.findIndex((p) => p.black === null);
      if (firstBye !== -1) assert.equal(firstBye, round.length - 1, "bye should be the last board");
    }
  }
});

test("the same roster always yields the same schedule", () => {
  const a = bergerSchedule(["ann", "bob", "cid", "dee", "eve"], true);
  const b = bergerSchedule(["ann", "bob", "cid", "dee", "eve"], true);
  assert.deepEqual(a, b);
});
