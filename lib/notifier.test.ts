/**
 * Tests for the notifier's pure decisions — the parts that decide WHICH game a pairing claims and
 * how the result is oriented. The network loop itself is exercised by `pnpm cron --dry-run`
 * against the live tournament; what is tested here is what a dry run cannot show until two games
 * between the same pair actually exist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { channelEnv, claimedGameUrls, flipResult, pickCandidate, type Candidate } from "./notifier";
import type { Tournament } from "./manifest";

const cand = (url: string, swapped: boolean): Candidate<string> => ({ game: url, swapped, url });

test("flipResult swaps decisive results and leaves a draw alone", () => {
  assert.equal(flipResult("1-0"), "0-1");
  assert.equal(flipResult("0-1"), "1-0");
  assert.equal(flipResult("½-½"), "½-½");
});

test("channelEnv uppercases and underscores the channel name", () => {
  assert.equal(channelEnv("marianczello"), "MARIANCZELLO_WEBHOOK");
  assert.equal(channelEnv("delayed-games"), "DELAYED_GAMES_WEBHOOK");
});

test("claimedGameUrls collects every url the manifest already spoke for", () => {
  const t = {
    rounds: [
      { round: 1, pairings: [
        { board: 1, white: "a", black: "b", result: "1-0", game_url: "u1" },
        { board: 2, white: "c", black: "d", result: "1-0" },   // walkover: no url to claim
        { board: 3, white: "e", black: null },                  // bye
      ] },
      { round: 2, pairings: [{ board: 1, white: "b", black: "a", result: "½-½", game_url: "u2" }] },
    ],
  } as unknown as Tournament;
  assert.deepEqual([...claimedGameUrls(t)], ["u1", "u2"]);
});

test("pickCandidate prefers the game whose colours match the declared pairing", () => {
  const pick = pickCandidate([cand("swapped", true), cand("declared", false)], new Set());
  assert.equal(pick?.url, "declared");
});

test("pickCandidate falls back to a swapped game when that is all there is", () => {
  const pick = pickCandidate([cand("swapped", true)], new Set());
  assert.equal(pick?.url, "swapped");
  assert.equal(pick?.swapped, true);
});

test("pickCandidate never returns a game another pairing already claimed", () => {
  const claimed = new Set(["taken"]);
  assert.equal(pickCandidate([cand("taken", false)], claimed), null);
  assert.equal(pickCandidate([cand("taken", false), cand("free", true)], claimed)?.url, "free");
});

test("pickCandidate takes the oldest when colours cannot distinguish the candidates", () => {
  // Candidates arrive oldest-first, so the assignment is reproducible run to run.
  assert.equal(pickCandidate([cand("older", false), cand("newer", false)], new Set())?.url, "older");
});

test("double round-robin: the two pairings of a pair claim different games", () => {
  // A-white and B-white are declared in the same window, so both searches see both games.
  const games = [cand("game-A-white", false), cand("game-B-white", true)];
  const claimed = new Set<string>();

  const first = pickCandidate(games, claimed);       // pairing white=A
  assert.equal(first?.url, "game-A-white");
  assert.equal(first?.swapped, false);
  claimed.add(first!.url);

  // The same two games seen from the other pairing's orientation: colours are mirrored.
  const mirrored = games.map((c) => ({ ...c, swapped: !c.swapped }));
  const second = pickCandidate(mirrored, claimed);   // pairing white=B
  assert.equal(second?.url, "game-B-white");
  assert.equal(second?.swapped, false);
});
