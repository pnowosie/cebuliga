/**
 * Tests for the commit message. The timestamps in the body are the raw material for tuning the
 * schedule later, so the cases that matter are the ones that would corrupt them quietly: a missing
 * end time must not become a fabricated one, and the format must stay parseable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildCommitMessage, formatPlayedAt, type PostedGame } from "./commit";

const game = (over: Partial<PostedGame> = {}): PostedGame => ({
  round: 1, board: 1, white: "alice", black: "bob", result: "1-0", ...over,
});

test("formatPlayedAt prints a UTC instant without milliseconds", () => {
  assert.equal(formatPlayedAt("2026-08-09T08:39:00Z"), "played 2026-08-09T08:39:00Z");
  assert.equal(formatPlayedAt("2026-08-09T08:39:12.345Z"), "played 2026-08-09T08:39:12Z");
});

test("formatPlayedAt normalises a non-UTC input to UTC", () => {
  assert.equal(formatPlayedAt("2026-08-09T10:39:00+02:00"), "played 2026-08-09T08:39:00Z");
});

test("a missing or unparseable end time yields no annotation rather than a wrong one", () => {
  assert.equal(formatPlayedAt(undefined), "");
  assert.equal(formatPlayedAt("not a date"), "");
});

test("no games means an ingest-only message", () => {
  assert.equal(buildCommitMessage([]), "notify: sync round files");
});

test("the title names the highest round, not the last one fetched", () => {
  const msg = buildCommitMessage([game({ round: 4 }), game({ round: 2 })]);
  assert.equal(msg.split("\n")[0], "notify: game results from 4 round");
});

test("every game gets a line with its end time", () => {
  const msg = buildCommitMessage([
    game({ round: 3, board: 1, endedAt: "2026-08-09T08:39:00Z" }),
    game({ round: 3, board: 2, endedAt: "2026-08-09T10:54:00Z", result: "½-½" }),
    game({ round: 4, board: 1, endedAt: "2026-08-09T22:29:00Z", result: "0-1" }),
  ]);
  assert.deepEqual(msg.split("\n").slice(3), [
    " ✅ r3#1 alice vs bob 1-0 — played 2026-08-09T08:39:00Z",
    " ✅ r3#2 alice vs bob ½-½ — played 2026-08-09T10:54:00Z",
    " ✅ r4#1 alice vs bob 0-1 — played 2026-08-09T22:29:00Z",
  ]);
});

test("a game with no end time still gets a line, just no annotation", () => {
  const msg = buildCommitMessage([game({ board: 7 })]);
  assert.ok(msg.includes(" ✅ r1#7 alice vs bob 1-0"));
  assert.ok(!msg.includes("played"));
});
