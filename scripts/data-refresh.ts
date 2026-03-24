#!/usr/bin/env bun
/**
 * 2kol tournament tracker
 *
 * Discovers match results from chess.com for two round-robin groups.
 * Each pair must play 2 games (one with each color). Tracks progress
 * and displays standings on every run.
 *
 * Usage: tournament.ts [--dry-run] [--verbose]
 */

import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logInfo, logError, logWarning } from "../lib/common.ts";
import {
  fetchPlayerMonthGames,
  type ChessComGame,
} from "../lib/chess.ts";

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Types ────────────────────────────────────────────────────────────────────

interface GroupConfig {
  startDate: string; // "YYYY-MM-DD"
  players: { number: number; nick: string }[];
}

interface GameRecord {
  id: string;   // numeric ID extracted from chess.com URL
  url: string;  // full chess.com game URL
  date: string; // "YYYY-MM-DD"
  white: string;
  black: string;
  result: string;          // "1-0", "0-1", "1/2-1/2"
  whiteRatingBefore: number;
  blackRatingBefore: number;
}

interface CompletedMatch {
  group: string;
  player1: string; // higher baseline-rated player
  player2: string;
  score1: number;
  score2: number;
  games: GameRecord[];
  recordedAt: string;
}

interface TournamentState {
  lastRun: string;
  startDate: string; // "YYYY-MM-DD" — tournament start, filters out pre-tournament games
  completedMatches: CompletedMatch[];
}

interface IncompleteMatch {
  group: string;
  whitePlayer: string;
  blackPlayer: string;
  game: GameRecord;
}

type MatchFindResult =
  | { status: "complete"; match: CompletedMatch }
  | { status: "incomplete"; info: IncompleteMatch }
  | { status: "not_found" };

// ─── State I/O ────────────────────────────────────────────────────────────────

const STATE_FILE = "../data/tournament.json";

async function loadState(): Promise<TournamentState> {
  try {
    const content = await readFile(join(__dir, STATE_FILE), "utf-8");
    const state = JSON.parse(content) as TournamentState;
    state.startDate ??= "2026-03-15";
    return state;
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return { lastRun: "", startDate: "2026-03-15", completedMatches: [] };
    }
    throw new Error(`Failed to load state: ${error.message}`);
  }
}

async function saveState(state: TournamentState): Promise<void> {
  state.lastRun = new Date().toISOString();
  await writeFile(
    join(__dir, STATE_FILE),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Returns all year/month pairs from startDate up to and including now.
 * Always fetches from startDate (not lastRun) to correctly handle
 * cross-month pairs: e.g. game 1 in March, game 2 in April.
 */
function getMonthsInRange(startDate: string, now: Date): { year: number; month: number }[] {
  const from = new Date(startDate);
  const months: { year: number; month: number }[] = [];
  let y = from.getFullYear();
  let m = from.getMonth() + 1;
  const toY = now.getFullYear();
  const toM = now.getMonth() + 1;

  while (y < toY || (y === toY && m <= toM)) {
    months.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

/**
 * Converts a chess.com player result string to a score.
 */
function resultToScore(result: string): number {
  if (result === "win") return 1;
  const draws = new Set([
    "stalemate", "insufficient", "50move", "repetition",
    "agreed", "timevsinsufficient", "kingofthehill",
  ]);
  if (draws.has(result)) return 0.5;
  // Known losses: checkmated, resigned, timeout, abandoned, bughousepartnerlose, lose
  return 0;
}

/**
 * Converts white player's result to standard chess notation.
 */
function normalizeResult(whiteResult: string): string {
  if (whiteResult === "win") return "1-0";
  if (resultToScore(whiteResult) === 0.5) return "1/2-1/2";
  return "0-1";
}

/**
 * Formats a numeric score for display (no trailing .0, keeps .5).
 */
function formatScore(score: number): string {
  return score % 1 === 0 ? score.toFixed(0) : score.toFixed(1);
}

/**
 * Extracts the numeric game ID from a chess.com game URL.
 */
function extractGameId(url: string): string {
  return url.split("/").pop() ?? url;
}

/**
 * Orders a pair so the higher baseline-rated player is first.
 * Falls back to alphabetical order on tie or missing rating.
 */
function orderPair(
  p1: string,
  p2: string,
  baselineRatings: Record<string, number>
): [string, string] {
  const r1 = baselineRatings[p1.toLowerCase()] ?? 0;
  const r2 = baselineRatings[p2.toLowerCase()] ?? 0;
  if (r1 >= r2) return [p1, p2];
  return [p2, p1];
}

/**
 * Generates all unique unordered pairs from a player list.
 * For 8 players: C(8,2) = 28 pairs.
 */
function generateAllPairs(players: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      pairs.push([players[i], players[j]]);
    }
  }
  return pairs;
}

function gameToRecord(game: ChessComGame, allGames: ChessComGame[]): GameRecord {
  const getPreGameRating = (playerUsername: string): number => {
    const uname = playerUsername.toLowerCase();
    const playerGames = allGames
      .filter((g) => {
        const isPlayer =
          g.white.username.toLowerCase() === uname ||
          g.black.username.toLowerCase() === uname;
        return isPlayer && g.time_class === game.time_class;
      })
      .sort((a, b) => a.end_time - b.end_time);

    const idx = playerGames.findIndex((g) => g.uuid === game.uuid);
    if (idx <= 0) {
      // No prior game found: post-game rating is the best available
      return uname === game.white.username.toLowerCase()
        ? game.white.rating
        : game.black.rating;
    }
    const prev = playerGames[idx - 1];
    return prev.white.username.toLowerCase() === uname
      ? prev.white.rating
      : prev.black.rating;
  };

  return {
    id: extractGameId(game.url),
    url: game.url,
    date: new Date(game.end_time * 1000).toISOString().slice(0, 10),
    white: game.white.username,
    black: game.black.username,
    result: normalizeResult(game.white.result),
    whiteRatingBefore: getPreGameRating(game.white.username),
    blackRatingBefore: getPreGameRating(game.black.username),
  };
}

// ─── Game cache + prefetch ────────────────────────────────────────────────────

type GameCache = Map<string, ChessComGame[]>;

function cacheKey(username: string, year: number, month: number): string {
  return `${username.toLowerCase()}:${year}:${String(month).padStart(2, "0")}`;
}

/**
 * Pre-fetches all players' games for the given months in parallel.
 * Uses the cache to avoid duplicate requests.
 */
async function prefetchGames(
  players: string[],
  months: { year: number; month: number }[],
  cache: GameCache,
  verbose: boolean
): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const player of players) {
    for (const { year, month } of months) {
      const key = cacheKey(player, year, month);
      if (cache.has(key)) continue;

      tasks.push(
        (async () => {
          if (verbose) logInfo(`Fetching games: ${player} ${year}/${String(month).padStart(2, "0")}`);
          const games = await fetchPlayerMonthGames(player, year, month);
          cache.set(key, games);
        })()
      );
    }
  }

  await Promise.all(tasks);
}

function getPlayerGamesFromCache(
  player: string,
  months: { year: number; month: number }[],
  cache: GameCache
): ChessComGame[] {
  return months.flatMap(({ year, month }) => cache.get(cacheKey(player, year, month)) ?? []);
}

// ─── Match discovery ──────────────────────────────────────────────────────────

/**
 * Finds the match result for a pair of players from the provided game list.
 *
 * A complete match requires:
 *   - One game where playerA played white vs playerB
 *   - One game where playerB played white vs playerA
 * (First occurrence of each color within the tournament date range.)
 */
function findMatchForPair(
  groupName: string,
  playerA: string,
  playerB: string,
  allGames: ChessComGame[],
  startDateMs: number,
  baselineRatings: Record<string, number>
): MatchFindResult {
  const aLower = playerA.toLowerCase();
  const bLower = playerB.toLowerCase();

  // Filter to rapid 15+10 games between these two players within date range
  const pairGames = allGames.filter((g) => {
    if (g.time_class !== "rapid" || g.time_control !== "900+10") return false;
    if (g.end_time * 1000 < startDateMs) return false;
    const wLower = g.white.username.toLowerCase();
    const blkLower = g.black.username.toLowerCase();
    return (
      (wLower === aLower && blkLower === bLower) ||
      (wLower === bLower && blkLower === aLower)
    );
  });

  // Sort by date ascending: take the earliest valid game of each color
  pairGames.sort((a, b) => a.end_time - b.end_time);

  const aAsWhite = pairGames.find((g) => g.white.username.toLowerCase() === aLower);
  const bAsWhite = pairGames.find(
    (g) => g.white.username.toLowerCase() === bLower && g.uuid !== aAsWhite?.uuid
  );

  if (!aAsWhite && !bAsWhite) {
    return { status: "not_found" };
  }

  if (aAsWhite && bAsWhite) {
    const [player1, player2] = orderPair(playerA, playerB, baselineRatings);
    const p1Lower = player1.toLowerCase();

    // Score for player1 across both games
    const score1 =
      (p1Lower === aLower
        ? resultToScore(aAsWhite.white.result)
        : resultToScore(aAsWhite.black.result)) +
      (p1Lower === bLower
        ? resultToScore(bAsWhite.white.result)
        : resultToScore(bAsWhite.black.result));

    const gamePair = [aAsWhite, bAsWhite].sort((a, b) => a.end_time - b.end_time);
    const match: CompletedMatch = {
      group: groupName,
      player1,
      player2,
      score1,
      score2: 2 - score1,
      games: gamePair.map((g) => gameToRecord(g, allGames)),
      recordedAt: new Date().toISOString(),
    };

    return { status: "complete", match };
  }

  // Incomplete: one color found
  const foundGame = (aAsWhite ?? bAsWhite)!;
  return {
    status: "incomplete",
    info: {
      group: groupName,
      whitePlayer: foundGame.white.username,
      blackPlayer: foundGame.black.username,
      game: gameToRecord(foundGame, allGames),
    },
  };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function getTopActivePlayers(
  players: string[],
  groupName: string,
  completedMatches: CompletedMatch[]
): { player: string; games: number }[] {
  const groupMatches = completedMatches.filter((m) => m.group === groupName);
  const gameCounts = new Map<string, number>();

  for (const match of groupMatches) {
    for (const p of [match.player1, match.player2]) {
      const key = p.toLowerCase();
      gameCounts.set(key, (gameCounts.get(key) ?? 0) + match.games.length);
    }
  }

  const sorted = players
    .map((p) => ({ player: p, games: gameCounts.get(p.toLowerCase()) ?? 0 }))
    .sort((a, b) => b.games - a.games)
    .filter((p) => p.games > 0);

  if (sorted.length <= 3) return sorted;

  // Include all players tied at the 3rd position
  const threshold = sorted[2].games;
  return sorted.filter((p) => p.games >= threshold);
}

function getFinalists(
  players: string[],
  groupName: string,
  completedMatches: CompletedMatch[]
): string[] {
  const matchesNeeded = players.length - 1; // 7 for 8 players
  const groupMatches = completedMatches.filter((m) => m.group === groupName);

  return players.filter((player) => {
    const pLower = player.toLowerCase();
    const count = groupMatches.filter(
      (m) =>
        m.player1.toLowerCase() === pLower ||
        m.player2.toLowerCase() === pLower
    ).length;
    return count >= matchesNeeded;
  });
}

/**
 * Finds the most recent tournament game date for a player across
 * completed matches and currently-incomplete matches.
 */
function getLastTournamentGameDate(
  playerNick: string,
  groupName: string,
  completedMatches: CompletedMatch[],
  incompleteMatches: IncompleteMatch[]
): string | null {
  const pLower = playerNick.toLowerCase();
  const dates: string[] = [];

  for (const match of completedMatches) {
    if (match.group !== groupName) continue;
    if (
      match.player1.toLowerCase() === pLower ||
      match.player2.toLowerCase() === pLower
    ) {
      for (const game of match.games) dates.push(game.date);
    }
  }

  for (const inc of incompleteMatches) {
    if (inc.group !== groupName) continue;
    if (
      inc.whitePlayer.toLowerCase() === pLower ||
      inc.blackPlayer.toLowerCase() === pLower
    ) {
      dates.push(inc.game.date);
    }
  }

  if (dates.length === 0) return null;
  return dates.sort().at(-1)!;
}

/**
 * Returns players who haven't played a tournament game in the last 7 days.
 * Finalists are excluded (they're done).
 */
function getMarauders(
  players: string[],
  groupName: string,
  completedMatches: CompletedMatch[],
  incompleteMatches: IncompleteMatch[],
  finalists: string[],
  now: Date
): string[] {
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoff = sevenDaysAgo.toISOString().slice(0, 10);

  const finalistSet = new Set(finalists.map((f) => f.toLowerCase()));

  return players.filter((player) => {
    if (finalistSet.has(player.toLowerCase())) return false;
    const lastGame = getLastTournamentGameDate(
      player, groupName, completedMatches, incompleteMatches
    );
    return lastGame === null || lastGame < cutoff;
  });
}

// ─── Output ───────────────────────────────────────────────────────────────────

function printSummary(
  newCompleted: CompletedMatch[],
  allIncomplete: IncompleteMatch[],
  allMatches: CompletedMatch[],
  groups: Record<string, GroupConfig>,
  now: Date
): void {
  // New activity
  const hasActivity = newCompleted.length > 0 || allIncomplete.length > 0;

  if (hasActivity) {
    console.log("\nActivity:");
    for (const match of newCompleted) {
      const s1 = formatScore(match.score1);
      const s2 = formatScore(match.score2);
      const ids = match.games.map((g) => g.id).join(", ");
      console.log(`  ✅ ${match.player1} ${s1} - ${s2} ${match.player2}  (${ids})`);
    }
    for (const inc of allIncomplete) {
      console.log(`  ⌛️  ${inc.whitePlayer} - ${inc.blackPlayer}  (${inc.game.id})`);
    }
  } else {
    logInfo("No new activity found this run.");
  }

  // Per-group stats
  console.log("");
  for (const [groupName, groupConfig] of Object.entries(groups)) {
    const players = groupConfig.players.map((p) => p.nick);
    const totalPairs = Math.round(players.length * (players.length - 1) / 2);
    const completed = allMatches.filter((m) => m.group === groupName).length;

    console.log(`Group ${groupName}: ${completed}/${totalPairs} matches completed`);

    const top3 = getTopActivePlayers(players, groupName, allMatches).filter(
      (p) => p.games > 0
    );
    if (top3.length > 0) {
      const top3Str = top3.map((p) => `${p.player} (${p.games})`).join(", ");
      console.log(`  Top 3: ${top3Str}`);
    }

    const finalists = getFinalists(players, groupName, allMatches);
    if (finalists.length > 0) {
      console.log(`  Finalists: ${finalists.join(", ")}`);
    }

    const numberByNick = new Map(
      groupConfig.players.map((p) => [p.nick.toLowerCase(), p.number])
    );
    const marauders = getMarauders(
      players, groupName, allMatches, allIncomplete, finalists, now
    );
    if (marauders.length > 0) {
      const formatted = marauders.map((nick) => {
        const num = numberByNick.get(nick.toLowerCase());
        return num !== undefined ? `${num}. ${nick}` : nick;
      });
      console.log(`  Marauders (7d idle): ${formatted.join(", ")}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");

  if (dryRun) logInfo("Dry run mode — state will not be saved");

  const state = await loadState();

  // Build group config and baseline ratings from data/players.json
  const playersRaw = JSON.parse(
    await readFile(join(__dir, "../data/players.json"), "utf-8")
  ) as Array<{ id: string; no: number; group: string; ranking: number }>;

  const baselineRatings: Record<string, number> = {};
  const groups: Record<string, GroupConfig> = {};
  for (const p of playersRaw) {
    baselineRatings[p.id.toLowerCase()] = p.ranking;
    if (!groups[p.group]) groups[p.group] = { startDate: state.startDate, players: [] };
    groups[p.group].players.push({ number: p.no, nick: p.id });
  }
  const config = { groups };

  const now = new Date();

  // Pre-fetch all players' games (always from startDate to handle cross-month pairs)
  const cache: GameCache = new Map();
  for (const [groupName, groupConfig] of Object.entries(config.groups)) {
    const months = getMonthsInRange(groupConfig.startDate, now);
    if (verbose) {
      logInfo(
        `Group ${groupName}: fetching ${months.length} month(s) — ` +
        months.map((m) => `${m.year}/${String(m.month).padStart(2, "0")}`).join(", ")
      );
    }
    await prefetchGames(groupConfig.players.map((p) => p.nick), months, cache, verbose);
  }

  // Build set of already-completed pair keys for fast lookup
  const completedPairKeys = new Set(
    state.completedMatches.map(
      (m) => `${m.group}:${m.player1.toLowerCase()}:${m.player2.toLowerCase()}`
    )
  );

  const newCompleted: CompletedMatch[] = [];
  const newIncomplete: IncompleteMatch[] = [];

  for (const [groupName, groupConfig] of Object.entries(config.groups)) {
    const { startDate } = groupConfig;
    const players = groupConfig.players.map((p) => p.nick);
    const months = getMonthsInRange(startDate, now);
    const startDateMs = new Date(startDate).getTime();
    const pairs = generateAllPairs(players);

    for (const [pa, pb] of pairs) {
      // Skip already-completed pairs (check both orderings)
      const key1 = `${groupName}:${pa.toLowerCase()}:${pb.toLowerCase()}`;
      const key2 = `${groupName}:${pb.toLowerCase()}:${pa.toLowerCase()}`;
      if (completedPairKeys.has(key1) || completedPairKeys.has(key2)) continue;

      // Merge and deduplicate games from both players
      const gamesA = getPlayerGamesFromCache(pa, months, cache);
      const gamesB = getPlayerGamesFromCache(pb, months, cache);
      const seen = new Set<string>();
      const mergedGames: ChessComGame[] = [];
      for (const g of [...gamesA, ...gamesB]) {
        if (!seen.has(g.uuid)) {
          seen.add(g.uuid);
          mergedGames.push(g);
        }
      }

      const result = findMatchForPair(
        groupName, pa, pb, mergedGames, startDateMs, baselineRatings
      );

      if (result.status === "complete") {
        newCompleted.push(result.match);
        state.completedMatches.push(result.match);
        completedPairKeys.add(key1);
      } else if (result.status === "incomplete") {
        newIncomplete.push(result.info);
      }
    }
  }

  // Persist state
  if (!dryRun && newCompleted.length > 0) {
    await saveState(state);
  }

  printSummary(newCompleted, newIncomplete, state.completedMatches, config.groups, now);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    logError(`Script failed: ${error.message}`);
    process.exit(1);
  });
}
