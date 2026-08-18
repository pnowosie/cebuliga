/**
 * Core notifier loop, ported from `org/game-notifier/src/lib/notifier.ts` — same names, same
 * shapes (`notify`, `NotifyOpts`, `NotifyResult`, `PostedGame`, `channelEnv`, `flipResult`,
 * `findGame`).
 *
 * For each active, in-window tournament: ingest new round files, then for every unresolved (no
 * `result`) pairing of every round — past rounds included, since a delayed game still counts —
 * find the game on the platform and record it. The manifest's `result` IS the dedup, and the
 * manifest is committed back to the repo by the caller. No Redis, no state file.
 *
 * ⚠ ANNOUNCING IS DISABLED HERE. `org/game-notifier` on Forgejo is the announcer now; this repo is
 * a pure UPDATER until it is decommissioned — it keeps the manifest (and therefore the site) fresh
 * and posts nothing. The webhook gate and the Discord post are commented out in place rather than
 * ported: upstream does this properly with `--no-announce` / `Tournament.notify` /
 * `Pairing.announced_at`, none of which is worth backporting into a repo scheduled for removal.
 * Re-enabling means reverting those two blocks — and must NEVER be done while game-notifier has
 * ANNOUNCE=true, or every result double-posts.
 *
 * Consequence: `NotifyResult.errors` is now always 0 (both sites that incremented it were Discord
 * failures), and `posted` means "discovered and recorded this run", not "announced".
 *
 * Three deliberate deltas from upstream, all to be mirrored back:
 *
 *  1. **Claim-dedup with colour preference.** Candidates are matched against the game URLs already
 *     claimed by resolved pairings, and a candidate whose ACTUAL colours match the declared
 *     pairing wins over one that doesn't. Without this a double round-robin — which declares two
 *     pairings per pair, one per colour, in the same window — hands both pairings the same game.
 *  2. **`colors_swapped` is persisted** on the pairing, not just appended to the Discord text.
 *     The site needs it to render the ⚠; upstream computes it and throws it away.
 *  3. **A failed Discord post no longer loses the run's earlier results.** It was logged, the
 *     tournament's loop stopped, and the manifest was still written for the games that DID post —
 *     otherwise a webhook error at board 5 makes boards 1-4 announce again on the next run.
 *     Moot while announcing is disabled; kept so the delta is still mirrored back upstream.
 */
import {
  chesscomScore, findChesscomGames, type ChessComGame,
  fetchLichessGame, findLichessGames, SKIP_STATUS, type LichessGame,
} from "./index";
import type { Logger } from "./common";
import { loadTournaments, syncRounds, writeIfChanged, type Score, type Tournament } from "./manifest";
import { applyBlockades } from "./forfeit";
import { postDelayedGameToDiscord, renderDiscordMessage } from "./discord";
import type { PostedGame } from "./commit";

export type { PostedGame };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function flipResult(r: Score): Score {
  return r === "1-0" ? "0-1" : r === "0-1" ? "1-0" : "½-½";
}

/** env var name for a channel's webhook, e.g. "delayed-games" → "DELAYED_GAMES_WEBHOOK". */
export function channelEnv(channel: string): string {
  return channel.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_WEBHOOK";
}

/**
 * Every game URL the manifest has already spoken for. A game claimed by one pairing must never be
 * claimed by another — that is what keeps the two halves of a double round-robin apart.
 * Keyed on the URL because it is what both platforms give us and what the manifest stores.
 */
export function claimedGameUrls(t: Tournament): Set<string> {
  const claimed = new Set<string>();
  for (const round of t.rounds) {
    for (const p of round.pairings) if (p.game_url) claimed.add(p.game_url);
  }
  return claimed;
}

/** A game that could be the pairing's, with the colour question already answered. */
export interface Candidate<T> {
  game: T;
  /** The players took the opposite colours to the declared pairing. */
  swapped: boolean;
  url: string;
}

/**
 * Which candidate this pairing takes: the first unclaimed one whose colours match the declared
 * pairing, or — failing that — the first unclaimed one at all, swapped.
 *
 * Colour preference is what makes the double-round-robin case fall out for free: the A-white
 * pairing takes the game A actually had white in, leaving the other for the B-white pairing.
 * Candidates arrive oldest-first, so with colours indistinguishable the earlier game wins and the
 * assignment is reproducible.
 */
export function pickCandidate<T>(candidates: Candidate<T>[], claimed: Set<string>): Candidate<T> | null {
  const free = candidates.filter((c) => !claimed.has(c.url));
  return free.find((c) => !c.swapped) ?? free[0] ?? null;
}

type Found =
  | { status: "found"; result: Score; gameUrl: string; swapped: boolean; endedAt?: string; warn?: string }
  | { status: "not_found" }
  | { status: "rate_limited" };

/** Finds the game between two nicks on the platform; flips the result if colours were swapped. */
async function findGame(
  t: Tournament,
  white: string,
  black: string,
  sinceMs: number,
  untilMs: number,
  ccCache: Map<string, ChessComGame[]>,
  claimed: Set<string>
): Promise<Found> {
  // `endedAt` is when the game FINISHED, per the platform — the input to the commit message's
  // hour buckets. Not the same thing as `updated_at`, which is when this run noticed it.
  const resolved = (result: Score, gameUrl: string, swapped: boolean, endedAt?: string): Found => ({
    status: "found",
    result: swapped ? flipResult(result) : result,
    gameUrl,
    swapped,
    endedAt,
    warn: swapped ? "  (colors swapped)" : undefined,
  });

  if (t.platform === "chesscom") {
    // Enforce the tournament's time CLASS so we match the tournament game, not a casual one (a
    // dry-run showed an unfiltered search picking a wrong-time-class game between the same pair).
    // The class, never the concrete clock: "900+10" is exactly the trap the old cebuliga script hit.
    const r = await findChesscomGames(white, black, sinceMs, untilMs, t.timeControl, ccCache);
    if (r.status === "rate_limited") return { status: "rate_limited" };

    const pick = pickCandidate(
      r.games.map((g) => ({
        game: g,
        swapped: g.white.username.toLowerCase() === black.toLowerCase(),
        url: g.url,
      })),
      claimed
    );
    if (!pick) return { status: "not_found" };
    // chess.com `end_time` is unix SECONDS.
    const endedAt = new Date(pick.game.end_time * 1000).toISOString();
    return resolved(chesscomScore(pick.game), pick.url, pick.swapped, endedAt);
  }

  // lichess: the summary line does not carry a trustworthy result, so each unclaimed candidate is
  // fetched in full (normally exactly one) before the colour question can be answered.
  const r = await findLichessGames(white, black, sinceMs, untilMs, t.timeControl);
  if (r.status === "rate_limited") return { status: "rate_limited" };

  const candidates: Candidate<LichessGame>[] = [];
  for (const summary of r.games) {
    const url = `https://lichess.org/${summary.id}`;
    if (claimed.has(url)) continue;
    const full = await fetchLichessGame(summary.id);
    if (!full) continue; // can't resolve it yet — retry next run
    if (SKIP_STATUS.has(full.status)) continue; // aborted, or still being played (no winner yet)
    candidates.push({
      game: full,
      swapped: full.players.white.userId?.toLowerCase() === black.toLowerCase(),
      url: `https://lichess.org/${full.id}`,
    });
  }
  const pick = pickCandidate(candidates, claimed);
  if (!pick) return { status: "not_found" };

  const g = pick.game;
  const score: Score = g.winner === "white" ? "1-0" : g.winner === "black" ? "0-1" : "½-½";
  // lichess timestamps are MILLISECONDS; `lastMoveAt` is the end of the game, `createdAt` its start.
  const endedAt = new Date(g.lastMoveAt ?? g.createdAt).toISOString();
  return resolved(score, pick.url, pick.swapped, endedAt);
}

export interface NotifyOpts {
  tournamentsDir: string;
  dryRun: boolean;
  log: Logger;
}

export interface NotifyResult {
  /** true if any manifest changed on disk (so the caller can commit). */
  changed: boolean;
  /** Games newly announced this run, in fetch order — for the commit message. */
  posted: PostedGame[];
  /** Failed Discord posts / missing webhooks. Non-zero ⇒ the run should exit non-zero. DELTA. */
  errors: number;
}

/** See {@link NotifyResult}: `changed` drives the commit; `posted` feeds the commit message. */
export async function notify({ tournamentsDir, dryRun, log }: NotifyOpts): Promise<NotifyResult> {
  const now = Date.now();
  let anyChange = false;
  let errors = 0;
  const postedGames: PostedGame[] = [];

  for (const { tournament: t, file } of loadTournaments(tournamentsDir)) {
    if (!t.active) { log.info(`skip ${t.slug}: inactive`); continue; }
    const start = Date.parse(t.startDate);
    const end = Date.parse(t.endDate);
    if (now < start || now > end) { log.info(`skip ${t.slug}: outside ${t.startDate}..${t.endDate}`); continue; }

    const ingested = await syncRounds(t, tournamentsDir);
    if (ingested) log.info(`${t.slug}: synced round file(s) (auto-created/materialized)`);

    // Defensive, and offline. Blockades are DETECTED upstream by game-notifier's `tourney refresh`;
    // this only enforces what the manifest already records. It has to run after syncRounds: a round
    // pasted after the blockade arrives unforfeited, and without this the loop below would go
    // hunting for the games of a player who has been withdrawn from the tournament.
    const forfeited = applyBlockades(t);
    if (forfeited) log.warn(`${t.slug}: walkowery applied for blocked account(s)`);

    // ANNOUNCING DISABLED — `org/game-notifier` on Forgejo is the announcer now. This repo is
    // phasing out; until it goes, it stays a pure UPDATER: it discovers games and keeps the
    // manifest (and therefore the site) fresh, and posts nothing.
    //
    // Deliberately a deletion rather than a port. Upstream does this properly with
    // `--no-announce` / `Tournament.notify` / `Pairing.announced_at`; none of that is worth
    // backporting into a repo scheduled for decommission. The cost is that this cron can no
    // longer announce at all without reverting the commit — which is the point.
    //
    // NEVER re-enable this while game-notifier has ANNOUNCE=true: two announcers on one channel
    // double-post every result.
    //
    // const webhook = process.env[channelEnv(t.channel)];
    // if (!webhook && !dryRun) {
    //   log.error(`${t.slug}: missing webhook env ${channelEnv(t.channel)} — skipping tournament`);
    //   errors++;
    //   if (writeIfChanged(file, t)) { anyChange = true; log.info(`${t.slug}: manifest updated (0 posted)`); }
    //   continue;
    // }

    const until = Math.min(now, end);
    const ccCache = new Map<string, ChessComGame[]>();
    const claimed = claimedGameUrls(t);
    let posted = 0;

    loop: for (const round of t.rounds) {
      // Search only within the round's window — the tournament-wide window mis-matches an earlier
      // game between the same two players (verified against real chess.com data).
      const since = round.startDate ? Date.parse(round.startDate) : start;
      for (const p of round.pairings) {
        if (p.result) continue;     // already resolved → never re-post (the dedup)
        // A walkower settles the board administratively, and a board that was never played carries
        // no `result` — so without this the withdrawn player's games get searched for on every run,
        // and anything he happened to play in the window would be announced as a tournament result.
        if (p.forfeit) continue;
        if (!p.black) continue;     // bye
        const found = await findGame(t, p.white, p.black, since, until, ccCache, claimed);
        if (found.status === "rate_limited") { log.warn(`${t.slug}: rate limited — stopping this run`); break loop; }
        if (found.status !== "found") continue;

        // Claim it even on a dry run, so the output shows two DIFFERENT games for the two
        // pairings of a pair instead of reporting the same one twice.
        claimed.add(found.gameUrl);

        const vars = {
          round: round.round, board: p.board, white: p.white, black: p.black,
          result: found.result, game_url: found.gameUrl, warn: found.warn,
        };

        if (dryRun) {
          log.info(`[dry] would record ${t.slug} r${round.round} b${p.board}:\n${renderDiscordMessage(vars)}`);
          continue;
        }

        // ANNOUNCING DISABLED — see the note above the webhook gate. The result is still written
        // to the manifest below; only the Discord post is gone.
        //
        // try {
        //   await postDelayedGameToDiscord(webhook!, vars);
        // } catch (e) {
        //   log.error(`${t.slug}: discord post failed at r${round.round} b${p.board}: ${(e as Error).message}`);
        //   errors++;
        //   break loop;
        // }

        p.result = found.result;
        p.game_url = found.gameUrl;
        p.updated_at = new Date().toISOString();
        if (found.swapped) p.colors_swapped = true;
        else delete p.colors_swapped; // never leave a stale ⚠ on a freshly resolved pairing
        postedGames.push({
          round: round.round, board: p.board, white: p.white, black: p.black,
          result: found.result, endedAt: found.endedAt,
        });
        posted++;
        log.success(`recorded ${t.slug} r${round.round} b${p.board}: ${found.result}${found.swapped ? " (colors swapped)" : ""}`);
        await sleep(t.platform === "lichess" ? 2000 : 1000); // courtesy throttle
      }
    }

    // Unconditional (`writeIfChanged` is already a no-op when nothing moved), matching upstream.
    // Gating this on `ingested || posted > 0` silently dropped every OTHER way the run mutates the
    // manifest — `delete p.colors_swapped` above, and now `applyBlockades`.
    if (!dryRun) {
      if (writeIfChanged(file, t)) { anyChange = true; log.info(`${t.slug}: manifest updated (${posted} posted)`); }
    }
  }

  return { changed: anyChange, posted: postedGames, errors };
}
