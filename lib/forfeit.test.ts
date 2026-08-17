import test from "node:test";
import assert from "node:assert/strict";
import { applyBlockades, blockOf, isBlocked, isSettled, pairingPoints } from "./forfeit";
import { computeStandings, playerGames, roundsProgress, tournamentProgress } from "./standings";
import { serialize, type Tournament } from "./manifest";

/**
 * The fixture is the LIVE marian-rapid-202608 shape at the moment TomasK14 was blocked, because
 * those three pairings are exactly the three cases that matter — and one of them is the trap:
 *   R1/b6 — played, and TomasK14 WON it, so the walkower contradicts the recorded result;
 *   R2/b2 — played, and he lost anyway, so the walkower agrees;
 *   R3/b5 — never played, so there is no result and no game url to show.
 */
function live(): Tournament {
  return {
    slug: "t", title: "T", platform: "chesscom", type: "swiss", organiser: "O",
    channel: "test", timeControl: "rapid", active: true, plannedRounds: 3,
    startDate: "2026-08-05T22:00:00.000Z", endDate: "2026-09-27T00:00:00.000Z",
    players: [
      { nick: "f0rk1ngtal", rating: 1867 }, { nick: "TomasK14", rating: 567 },
      { nick: "Akibajedynka", rating: 2316 }, { nick: "ZugsonChess", rating: 1851 },
    ],
    rounds: [
      { round: 1, pairings: [{
        board: 6, white: "f0rk1ngtal", black: "TomasK14",
        result: "0-1", game_url: "https://www.chess.com/game/live/172759598834",
      }] },
      { round: 2, pairings: [{
        board: 2, white: "TomasK14", black: "Akibajedynka",
        result: "0-1", game_url: "https://www.chess.com/game/live/172902996930",
      }] },
      // Pairing casing deliberately disagrees with players[] — it does in the real manifest.
      { round: 3, pairings: [{ board: 5, white: "Zugsonchess", black: "TomasK14" }] },
    ],
  };
}

const blocked = (t: Tournament, nick = "tomask14", reason = "closed:fair_play_violations") => {
  (t.blocked ??= {})[nick] = { detected_at: "2026-08-17T10:37:36.729Z", reason };
  return t;
};
const pts = (t: Tournament, nick: string) =>
  computeStandings(t).find((s) => s.nick.toLowerCase() === nick.toLowerCase())!;

test("the played result survives a walkower — only the score flips", () => {
  const t = blocked(live());
  applyBlockades(t);

  const p = t.rounds[0].pairings[0]; // f0rk1ngtal vs TomasK14, stored 0-1 = TomasK14 won
  assert.equal(p.forfeit, "black");
  assert.equal(p.result, "0-1", "the record of what happened must not be rewritten");
  assert.equal(p.game_url, "https://www.chess.com/game/live/172759598834");
  assert.deepEqual(pairingPoints(p), { white: 1, black: 0 });
});

test("a never-played walkower invents neither a result nor a game url", () => {
  const t = blocked(live());
  applyBlockades(t);
  const p = t.rounds[2].pairings[0];
  assert.equal(p.forfeit, "black", "matched despite Zugsonchess/ZugsonChess casing");
  assert.equal(p.result, undefined);
  assert.equal(p.game_url, undefined);
  assert.ok(isSettled(p));
});

test("applyBlockades is idempotent, additive, and a no-op without blockades", () => {
  const t = blocked(live());
  assert.equal(applyBlockades(t), true);
  const once = serialize(t);
  assert.equal(applyBlockades(t), false);
  assert.equal(serialize(t), once);
  assert.equal(applyBlockades(live()), false);
});

test("two blocked players score 0-0, which no Score value could express", () => {
  const t = blocked(blocked(live()), "zugsonchess", "closed");
  applyBlockades(t);
  const p = t.rounds[2].pairings[0];
  assert.equal(p.forfeit, "both");
  assert.deepEqual(pairingPoints(p), { white: 0, black: 0 });
});

test("standings: the blocked player scores nothing, his opponents get the point", () => {
  const t = blocked(live());
  applyBlockades(t);

  assert.equal(pts(t, "TomasK14").points, 0, "all three games lost");
  assert.equal(pts(t, "TomasK14").blocked, true);
  // He had WON R1 against f0rk1ngtal; the walkower hands that point over.
  assert.equal(pts(t, "f0rk1ngtal").points, 1);
  assert.equal(pts(t, "Akibajedynka").points, 1);
  assert.equal(pts(t, "ZugsonChess").points, 1, "a round he never played still awards the point");
  assert.equal(pts(t, "f0rk1ngtal").blocked, false);
});

test("walkowery contribute no Buchholz term, so opponents are not punished for the draw", () => {
  const t = blocked(live());
  applyBlockades(t);
  // Every one of these players' only game is against the blocked player.
  for (const nick of ["f0rk1ngtal", "Akibajedynka", "ZugsonChess"]) {
    assert.equal(pts(t, nick).buchholz, 0, `${nick} keeps a clean Buchholz`);
  }
  // Games played still counts them: the pairing IS decided.
  assert.equal(pts(t, "f0rk1ngtal").games, 1);
});

test("a withdrawn player loses his bye point too", () => {
  const t = blocked(live());
  t.rounds.push({ round: 4, pairings: [{ board: 1, white: "TomasK14", black: null }] });
  applyBlockades(t);

  const s = pts(t, "TomasK14");
  assert.equal(s.points, 0, "'all games lost' plus a free pauza point would be incoherent");
  assert.equal(s.byes, 1, "the bye still happened; it just scores nothing");
  assert.equal(t.rounds[3].pairings[0].forfeit, undefined, "a bye is never forfeited");

  const bye = playerGames(t, "TomasK14").find((g) => g.bye)!;
  assert.equal(bye.score, 0);
});

test("playerGames marks the opponent, never the honest player", () => {
  const t = blocked(live());
  applyBlockades(t);

  const honest = playerGames(t, "f0rk1ngtal")[0];
  assert.equal(honest.score, 1, "he is awarded the point");
  assert.equal(honest.forfeit, true);
  assert.equal(honest.opponentBlocked, true, "🚫 goes on TomasK14's nick");
  assert.equal(honest.result, "0-1", "the played result is still available for the tooltip");

  const cheat = playerGames(t, "TomasK14")[0];
  assert.equal(cheat.score, 0);
  assert.equal(cheat.forfeit, true);
  assert.equal(cheat.opponentBlocked, false, "his opponent must never be badged 🚫");
});

test("a walkower counts as resolved, so the progress bars can reach 100%", () => {
  const t = blocked(live());
  applyBlockades(t);
  assert.deepEqual(tournamentProgress(t), { resolved: 3, total: 3 });
  assert.deepEqual(roundsProgress(t), { resolved: 3, total: 3 });
});

test("isBlocked / blockOf are case-insensitive and null-safe", () => {
  const t = blocked(live());
  assert.equal(isBlocked(t, "TomasK14"), true);
  assert.equal(isBlocked(t, "tomask14"), true);
  assert.equal(isBlocked(t, "f0rk1ngtal"), false);
  assert.equal(isBlocked(t, null), false);
  assert.equal(blockOf(t, "TOMASK14")?.reason, "closed:fair_play_violations");
  assert.equal(blockOf(t, null), undefined);
});

test("pairingPoints: forfeit outranks result", () => {
  assert.equal(pairingPoints({ board: 1, white: "a", black: "b" }), null);
  assert.deepEqual(pairingPoints({ board: 1, white: "a", black: "b", result: "½-½" }), { white: 0.5, black: 0.5 });
  assert.deepEqual(
    pairingPoints({ board: 1, white: "a", black: "b", result: "1-0", forfeit: "white" }),
    { white: 0, black: 1 }
  );
});
