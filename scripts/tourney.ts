/**
 * `tourney` — the admin CLI for the tournament manifests. Run it as `pnpm tourney <command>`.
 *
 * NOT `pnpm t`: `t` is pnpm's own alias for `test` (see `pnpm help -a`), so `pnpm t add …` would
 * run the test script instead of this one.
 *
 * ENGLISH, deliberately, even though the site it feeds is Polish. The site is what the players
 * read; this is admin tooling whose output lands in terminal scrollback and commit messages, and
 * it should read like any other CLI.
 *
 * Every mutating command goes through `writeIfChanged`, so re-running one is a no-op and
 * `git status` stays the honest report of what happened. `--dry-run` works on all of them.
 *
 * Exit codes: 0 ok · 1 usage or data error · 2 platform/network error.
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadTournaments,
  serialize,
  syncRounds,
  writeIfChanged,
  type Player,
  type Round,
  type Score,
  type Tournament,
  type TournamentType,
} from "../lib/manifest";
import { TOURNAMENTS_DIR, tournamentStatus } from "../lib/display";
import { rosterOf, tournamentProgress } from "../lib/standings";
import { bergerSchedule } from "../lib/berger";
import { PlatformError, THROTTLE_MS, fetchProfile, perfKey, sleep } from "../lib/index";

const DAY_MS = 86_400_000;

/** A mistake the user can fix by typing something different. Exit code 1. */
class UsageError extends Error {}

// ─── argument plumbing ───────────────────────────────────────────────────────

/**
 * One merged option spec for every command. A flag that means nothing to the command in hand is
 * simply ignored — cheaper than a per-command parser, and there are no conflicting meanings.
 */
const OPTIONS = {
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  json: { type: "boolean" },
  offline: { type: "boolean" },
  players: { type: "string", multiple: true },
  title: { type: "string" },
  organiser: { type: "string" },
  channel: { type: "string" },
  "time-control": { type: "string" },
  "clock-info": { type: "string" },
  start: { type: "string" },
  end: { type: "string" },
  "cm-url": { type: "string" },
  rounds: { type: "string" },
  round: { type: "string" },
  every: { type: "string" },
  swapped: { type: "boolean" },
  clear: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type Values = Partial<{
  [K in keyof typeof OPTIONS]: (typeof OPTIONS)[K] extends { multiple: true }
    ? string[]
    : (typeof OPTIONS)[K]["type"] extends "boolean"
      ? boolean
      : string;
}>;

let DRY_RUN = false;

// ─── output helpers ──────────────────────────────────────────────────────────

const out = (line = "") => console.log(line);

/** Left-aligned columns, sized to their contents. Row 0 is the header. */
function table(rows: string[][]): void {
  if (!rows.length) return;
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  for (const row of rows) {
    out(row.map((cell, c) => (cell ?? "").padEnd(c === row.length - 1 ? 0 : widths[c])).join("  ").trimEnd());
  }
}

// ─── manifest plumbing ───────────────────────────────────────────────────────

function loadOne(slug: string): { t: Tournament; file: string } {
  const all = loadTournaments(TOURNAMENTS_DIR);
  const hit = all.find((x) => x.tournament.slug.toLowerCase() === slug.toLowerCase());
  if (!hit) {
    const known = all.map((x) => x.tournament.slug).sort().join(", ") || "none";
    throw new UsageError(`no tournament with slug "${slug}" (known slugs: ${known})`);
  }
  return { t: hit.tournament, file: hit.file };
}

/** The single write path. Returns whether anything actually changed. */
function save(file: string, t: Tournament): boolean {
  if (DRY_RUN) {
    const changed = !existsSync(file) || readFileSync(file, "utf8") !== serialize(t);
    out(changed ? `[dry-run] would write ${file}` : `[dry-run] no changes`);
    return changed;
  }
  const written = writeIfChanged(file, t);
  out(written ? `wrote ${file}` : "no changes");
  return written;
}

const lc = (s: string) => s.trim().toLowerCase();

/** Every pairing a nick appears in, either colour. Used to guard `rm`. */
function pairingsWith(t: Tournament, nick: string): { round: number; board: number }[] {
  const k = lc(nick);
  const hits: { round: number; board: number }[] = [];
  for (const r of t.rounds) {
    for (const p of r.pairings) {
      if (lc(p.white) === k || (p.black && lc(p.black) === k)) hits.push({ round: r.round, board: p.board });
    }
  }
  return hits;
}

function requireArgs(positionals: string[], n: number, usage: string): void {
  if (positionals.length < n) throw new UsageError(`usage: tourney ${usage}`);
}

/**
 * `perfKey` validates manifest data, not the network, so its complaint is something the user
 * fixes by editing a field — exit 1, not the exit 2 a transport failure earns.
 */
function perfFor(platform: Tournament["platform"], timeControl: string): string {
  try {
    return perfKey(platform, timeControl);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

// ─── roster mutation, shared by `add` and `init` ─────────────────────────────

interface AddOutcome {
  added: number;
  /** Nicks the platform doesn't know, or that were already present. Exit code 1. */
  rejected: number;
  /** A transport failure stopped the batch early. Exit code 2. */
  aborted: boolean;
}

/**
 * Looks each nick up and appends it to `t.players`. Never throws for a bad nick — an unknown
 * player is reported and skipped so one typo can't cost you the rest of the batch.
 *
 * A transport failure (429, 5xx) DOES stop the loop: continuing past a rate limit just burns
 * more requests. Whatever was collected before that point stays in `t` for the caller to save.
 */
async function addPlayers(t: Tournament, nicks: string[], offline: boolean): Promise<AddOutcome> {
  const perf = offline ? "" : perfFor(t.platform, t.timeControl);
  t.players ??= [];
  const have = new Set(t.players.map((p) => lc(p.nick)));
  const outcome: AddOutcome = { added: 0, rejected: 0, aborted: false };
  let firstLookup = true;

  for (const raw of nicks) {
    const nick = raw.trim();
    if (!nick) continue;

    if (have.has(lc(nick))) {
      out(`  = ${nick} — already on the roster`);
      outcome.rejected++;
      continue;
    }

    if (offline) {
      t.players.push({ nick });
      have.add(lc(nick));
      outcome.added++;
      out(`  + ${nick} — no profile lookup (--offline)`);
      continue;
    }

    if (!firstLookup) await sleep(THROTTLE_MS);
    firstLookup = false;

    let profile;
    try {
      profile = await fetchProfile(t.platform, nick, perf);
    } catch (e) {
      if (!(e instanceof PlatformError)) throw e;
      out(`  ! ${nick} — ${e.message}`);
      out(`  stopping here; the players added so far are kept`);
      outcome.aborted = true;
      break;
    }

    if (!profile) {
      out(`  ! ${nick} — no such player on ${t.platform}`);
      outcome.rejected++;
      continue;
    }

    // Field order mirrors the `Player` interface, so manifests stay diffable.
    const player: Player = { nick: profile.nick };
    if (profile.name) player.name = profile.name;
    if (typeof profile.rating === "number") player.rating = profile.rating;
    if (profile.avatar) player.avatar = profile.avatar;

    t.players.push(player);
    have.add(lc(profile.nick));
    outcome.added++;

    const notes = [
      player.rating !== undefined ? `${t.timeControl} ${player.rating}` : "no rating",
      player.name ? `name "${player.name}"` : null,
      player.avatar ? "avatar" : null,
    ].filter(Boolean);
    const renamed = lc(profile.nick) === lc(nick) && profile.nick !== nick ? ` (was typed "${nick}")` : "";
    out(`  + ${profile.nick}${renamed} — ${notes.join(", ")}`);
  }

  return outcome;
}

/**
 * Nick sources for `--players`: a literal comma list, `@path` for a file, or `-` for stdin.
 * Files and stdin are one nick per line, `#` starts a comment — the shape a sign-up list
 * actually arrives in.
 */
function readNickList(spec: string): string[] {
  let text: string;
  if (spec === "-") {
    text = readFileSync(0, "utf8");
  } else if (spec.startsWith("@")) {
    const path = spec.slice(1);
    if (!existsSync(path)) throw new UsageError(`no such file: ${path}`);
    text = readFileSync(path, "utf8");
  } else {
    return spec.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

// ─── commands ────────────────────────────────────────────────────────────────

function cmdList(): void {
  const all = loadTournaments(TOURNAMENTS_DIR).map((x) => x.tournament);
  if (!all.length) {
    out(`no manifests in ${TOURNAMENTS_DIR}/`);
    return;
  }
  const rows = [["SLUG", "STATUS", "TYPE", "PLATFORM", "PLAYERS", "ROUNDS", "RESOLVED"]];
  for (const t of all.sort((a, b) => a.slug.localeCompare(b.slug))) {
    const { resolved, total } = tournamentProgress(t);
    rows.push([
      t.slug,
      tournamentStatus(t),
      t.type,
      t.platform,
      String(rosterOf(t).length),
      String(t.rounds.length),
      `${resolved}/${total}`,
    ]);
  }
  table(rows);
}

function cmdPlayers(positionals: string[], values: Values): void {
  requireArgs(positionals, 1, "players <slug> [--json]");
  const { t } = loadOne(positionals[0]);
  const players = t.players ?? [];

  if (values.json) {
    out(JSON.stringify(players, null, 2));
    return;
  }
  if (!players.length) {
    out(`${t.slug} has no roster yet — add players with: tourney add ${t.slug} <nick...>`);
    return;
  }

  const rows = [["#", "NICK", "RATING", "NAME", "AVATAR"]];
  players.forEach((p, i) => {
    rows.push([
      String(i + 1),
      p.nick,
      p.rating !== undefined ? String(p.rating) : "-",
      p.name ?? "-",
      p.avatar ? "yes" : "-",
    ]);
  });
  table(rows);
  out();
  out(`${players.length} players, in draw order (this order seeds the pairings)`);
}

function cmdStatus(positionals: string[]): void {
  requireArgs(positionals, 1, "status <slug>");
  const { t, file } = loadOne(positionals[0]);
  const { resolved, total } = tournamentProgress(t);

  out(`${t.slug} — ${t.title}`);
  out(`  file       ${file}`);
  out(`  status     ${tournamentStatus(t)} (active: ${t.active})`);
  out(`  dates      ${t.startDate.slice(0, 10)} → ${t.endDate.slice(0, 10)}`);
  out(`  format     ${t.type} on ${t.platform}, ${t.timeControl}${t.clockInfo ? ` (${t.clockInfo})` : ""}`);
  out(`  players    ${(t.players ?? []).length} on the roster, ${rosterOf(t).length} seen in total`);
  out(`  rounds     ${t.rounds.length}${t.plannedRounds ? ` of ${t.plannedRounds} planned` : ""}`);

  for (const r of [...t.rounds].sort((a, b) => a.round - b.round)) {
    const done = r.pairings.filter((p) => p.result || p.black === null).length;
    const flag = r.pairings.length && done === r.pairings.length ? "complete" : "";
    out(`    R${String(r.round).padEnd(3)} ${done}/${r.pairings.length} ${flag}`);
  }
  out(`  resolved   ${resolved}/${total} pairings`);

  // Warnings are the point of this command: they are the things that silently render wrong.
  const warnings: string[] = [];
  const roster = new Set((t.players ?? []).map((p) => lc(p.nick)));
  if (roster.size) {
    const strays = new Set<string>();
    for (const r of t.rounds) {
      for (const p of r.pairings) {
        for (const nick of [p.white, p.black]) {
          if (nick && !roster.has(lc(nick))) strays.add(nick);
        }
      }
    }
    for (const s of strays) warnings.push(`"${s}" plays but is not on the roster`);
  }
  const unrated = (t.players ?? []).filter((p) => p.rating === undefined).map((p) => p.nick);
  if (unrated.length) warnings.push(`no rating: ${unrated.join(", ")} — try: tourney refresh ${t.slug}`);
  if (t.plannedRounds && t.rounds.length > t.plannedRounds) {
    warnings.push(`${t.rounds.length} rounds exist but plannedRounds is ${t.plannedRounds} — the site shows the larger`);
  }
  const undated = t.rounds.filter((r) => !r.startDate).map((r) => r.round);
  if (undated.length) warnings.push(`no startDate on round(s) ${undated.join(", ")} — the cron needs it`);

  if (warnings.length) {
    out();
    out("warnings:");
    for (const w of warnings) out(`  - ${w}`);
  }
}

const TYPE_ALIASES: Record<string, TournamentType> = {
  swiss: "swiss",
  s: "swiss",
  "round-robin": "round-robin",
  rr: "round-robin",
  "double-round-robin": "double-round-robin",
  "2rr": "double-round-robin",
  drr: "double-round-robin",
};

const PLATFORM_ALIASES: Record<string, Tournament["platform"]> = {
  chesscom: "chesscom",
  "chess.com": "chesscom",
  cc: "chesscom",
  lichess: "lichess",
  "lichess.org": "lichess",
  li: "lichess",
};

function parseDate(input: string, what: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(input) ? new Date(`${input}T00:00:00.000Z`) : new Date(input);
  if (isNaN(d.getTime())) throw new UsageError(`invalid --${what}: "${input}" (expected YYYY-MM-DD)`);
  return d.toISOString();
}

function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function cmdInit(positionals: string[], values: Values): Promise<number> {
  requireArgs(positionals, 3, "init <slug> <type> <platform> [nick...]");
  const [slugRaw, typeRaw, platformRaw, ...inlineNicks] = positionals;

  const slug = slugRaw.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new UsageError(`invalid slug "${slug}": lowercase letters, digits and dashes only (it is the filename and the URL)`);
  }
  const type = TYPE_ALIASES[lc(typeRaw)];
  if (!type) throw new UsageError(`unknown type "${typeRaw}" (swiss | round-robin/rr | double-round-robin/2rr)`);
  const platform = PLATFORM_ALIASES[lc(platformRaw)];
  if (!platform) throw new UsageError(`unknown platform "${platformRaw}" (chesscom/cc | lichess/li)`);

  const file = join(TOURNAMENTS_DIR, `${slug}.json`);
  if (existsSync(file) && !values.force) {
    throw new UsageError(`${file} already exists — pass --force to overwrite it`);
  }

  const timeControl = values["time-control"] ?? "rapid";
  perfFor(platform, timeControl); // fail now, not once someone runs `add`

  // Display only — the schedule itself still comes from pastes (swiss) or Berger (r-r).
  const plannedRounds = values.rounds ? Number(values.rounds) : 0;
  if (values.rounds && (!Number.isInteger(plannedRounds) || plannedRounds < 1)) {
    throw new UsageError("--rounds must be a positive integer (how many rounds the event has)");
  }

  const start = values.start ? parseDate(values.start, "start") : todayUTC().toISOString();
  const end = values.end
    ? parseDate(values.end, "end")
    : new Date(Date.parse(start) + 60 * DAY_MS).toISOString();
  if (Date.parse(end) < Date.parse(start)) throw new UsageError("--end is before --start");

  // Key order matches the `Tournament` interface so every manifest diffs cleanly against the rest.
  const t: Tournament = {
    slug,
    title: values.title ?? slug,
    platform,
    type,
    organiser: values.organiser ?? "",
    channel: values.channel ?? slug,
    timeControl,
    ...(values["clock-info"] ? { clockInfo: values["clock-info"] } : {}),
    active: true,
    startDate: start,
    endDate: end,
    ...(values["cm-url"] ? { cmUrl: values["cm-url"] } : {}),
    players: [],
    ...(plannedRounds ? { plannedRounds } : {}),
    rounds: [],
  };

  // Write the scaffold BEFORE touching the network: a typo'd nick or an API hiccup then costs
  // you the roster, never the manifest — you just re-run `add`.
  save(file, t);

  const nicks = [...inlineNicks, ...(values.players ?? []).flatMap(readNickList)];
  let outcome: AddOutcome = { added: 0, rejected: 0, aborted: false };
  if (nicks.length) {
    out();
    out(`adding ${nicks.length} player(s):`);
    outcome = await addPlayers(t, nicks, values.offline === true);
    save(file, t);
  }

  // Only mention what is actually still missing — a checklist that lists things you just set
  // trains you to ignore it.
  out();
  out("next steps:");
  if (!t.organiser) out(`  - set "organiser" (or pass --organiser)`);
  if (!values.title) out(`  - set "title" (it currently repeats the slug)`);
  if (!values.start || !values.end) out(`  - check the dates: ${start.slice(0, 10)} → ${end.slice(0, 10)}`);
  if (!t.cmUrl) out(`  - set "cmUrl" if the event has a ChessManager page`);
  if (!t.clockInfo) out(`  - set "clockInfo" for the display clock, e.g. "⌛ 10'+5\\""`);
  if (!t.plannedRounds) out(`  - set "plannedRounds" (or pass --rounds N) so the site can show "runda 1 / N"`);
  if (!nicks.length) out(`  - add players: tourney add ${slug} <nick...>`);
  out(
    t.type === "swiss"
      ? `  - drop ChessManager pastes in ${join(TOURNAMENTS_DIR, slug)}/r<N>.txt, then: tourney pair ${slug}`
      : `  - generate pairings: tourney pair ${slug}`
  );

  return outcome.aborted ? 2 : outcome.rejected ? 1 : 0;
}

async function cmdAdd(positionals: string[], values: Values): Promise<number> {
  // Only the slug is required as a positional: the nicks may arrive entirely through
  // `--players @file` / `--players -`.
  requireArgs(positionals, 1, "add <slug> <nick...>   (or: add <slug> --players @file | -)");
  const [slug, ...inline] = positionals;
  const { t, file } = loadOne(slug);

  const nicks = [...inline, ...(values.players ?? []).flatMap(readNickList)];
  if (!nicks.length) throw new UsageError("no nicks given — pass them as arguments or via --players");

  const outcome = await addPlayers(t, nicks, values.offline === true);
  save(file, t);
  out(`${outcome.added} added, ${outcome.rejected} skipped`);
  return outcome.aborted ? 2 : outcome.rejected ? 1 : 0;
}

function cmdRm(positionals: string[], values: Values): number {
  requireArgs(positionals, 2, "rm <slug> <nick...>");
  const [slug, ...nicks] = positionals;
  const { t, file } = loadOne(slug);
  t.players ??= [];

  let removed = 0;
  let refused = 0;
  for (const nick of nicks) {
    const idx = t.players.findIndex((p) => lc(p.nick) === lc(nick));
    if (idx === -1) {
      out(`  ! ${nick} — not on the roster`);
      refused++;
      continue;
    }
    const played = pairingsWith(t, nick);
    if (played.length && !values.force) {
      const where = played.map((h) => `R${h.round}/b${h.board}`).join(", ");
      out(`  ! ${nick} — appears in ${played.length} pairing(s): ${where} — pass --force to remove anyway`);
      refused++;
      continue;
    }
    t.players.splice(idx, 1);
    removed++;
    out(`  - ${nick}${played.length ? ` (forced; ${played.length} pairing(s) now reference a non-roster nick)` : ""}`);
  }

  save(file, t);
  return refused ? 1 : 0;
}

async function cmdRefresh(positionals: string[]): Promise<number> {
  requireArgs(positionals, 1, "refresh <slug> [nick...]");
  const [slug, ...only] = positionals;
  const { t, file } = loadOne(slug);
  const players = t.players ?? [];
  if (!players.length) throw new UsageError(`${t.slug} has no roster to refresh`);

  const perf = perfFor(t.platform, t.timeControl);
  const wanted = only.length ? new Set(only.map(lc)) : null;
  const targets = players.filter((p) => !wanted || wanted.has(lc(p.nick)));
  if (!targets.length) throw new UsageError(`none of those nicks are on the roster`);

  let changed = 0;
  let failed = 0;
  let aborted = false;
  let firstLookup = true;

  for (const p of targets) {
    if (!firstLookup) await sleep(THROTTLE_MS);
    firstLookup = false;

    let profile;
    try {
      profile = await fetchProfile(t.platform, p.nick, perf);
    } catch (e) {
      if (!(e instanceof PlatformError)) throw e;
      out(`  ! ${p.nick} — ${e.message}`);
      out(`  stopping here; the players refreshed so far are kept`);
      aborted = true;
      break;
    }
    if (!profile) {
      out(`  ! ${p.nick} — no such player on ${t.platform} any more`);
      failed++;
      continue;
    }

    // The manifest holds a SNAPSHOT of the profile, so a field the platform no longer returns
    // is removed rather than left to go stale.
    const diffs: string[] = [];
    if (profile.nick !== p.nick) {
      diffs.push(`nick ${p.nick} → ${profile.nick}`);
      p.nick = profile.nick;
    }
    if (profile.rating !== p.rating) {
      diffs.push(`rating ${p.rating ?? "-"} → ${profile.rating ?? "-"}`);
      if (profile.rating === undefined) delete p.rating;
      else p.rating = profile.rating;
    }
    if ((profile.name ?? undefined) !== p.name) {
      diffs.push(`name ${p.name ?? "-"} → ${profile.name ?? "-"}`);
      if (!profile.name) delete p.name;
      else p.name = profile.name;
    }
    if ((profile.avatar ?? undefined) !== p.avatar) {
      diffs.push("avatar changed");
      if (!profile.avatar) delete p.avatar;
      else p.avatar = profile.avatar;
    }

    if (diffs.length) {
      changed++;
      out(`  ~ ${p.nick} — ${diffs.join("; ")}`);
    } else {
      out(`  = ${p.nick} — ${p.rating ?? "no rating"}`);
    }
  }

  save(file, t);
  out(`${changed} of ${targets.length} changed`);
  return aborted ? 2 : failed ? 1 : 0;
}

const RESULT_ALIASES: Record<string, Score> = {
  "1-0": "1-0",
  "1:0": "1-0",
  "1": "1-0",
  w: "1-0",
  "0-1": "0-1",
  "0:1": "0-1",
  "0": "0-1",
  l: "0-1",
  "½-½": "½-½",
  "1/2": "½-½",
  "1/2-1/2": "½-½",
  "0.5": "½-½",
  "=": "½-½",
  d: "½-½",
  draw: "½-½",
};

function cmdResult(positionals: string[], values: Values): number {
  requireArgs(positionals, 3, "result <slug> <round> <board> <result> [url]");
  const [slug, roundRaw, boardRaw, resultRaw, urlRaw] = positionals;
  const { t, file } = loadOne(slug);

  const roundNo = Number(roundRaw);
  const board = Number(boardRaw);
  if (!Number.isInteger(roundNo) || !Number.isInteger(board)) {
    throw new UsageError("round and board must be integers");
  }

  const round = t.rounds.find((r) => r.round === roundNo);
  if (!round) throw new UsageError(`${t.slug} has no round ${roundNo}`);
  const pairing = round.pairings.find((p) => p.board === board);
  if (!pairing) {
    const boards = round.pairings.map((p) => p.board).join(", ");
    throw new UsageError(`round ${roundNo} has no board ${board} (boards: ${boards})`);
  }
  if (pairing.black === null) throw new UsageError(`R${roundNo}/b${board} is a bye — it scores on its own`);

  const who = `${pairing.white} – ${pairing.black}`;

  if (values.clear) {
    if (!pairing.result) {
      out(`R${roundNo}/b${board} ${who} — already unresolved`);
    } else {
      out(`R${roundNo}/b${board} ${who} — cleared (was ${pairing.result})`);
      delete pairing.result;
      delete pairing.game_url;
      delete pairing.updated_at;
      delete pairing.colors_swapped;
    }
    save(file, t);
    return 0;
  }

  if (!resultRaw) throw new UsageError("usage: tourney result <slug> <round> <board> <result> [url]");
  const score = RESULT_ALIASES[lc(resultRaw)];
  if (!score) {
    throw new UsageError(`unknown result "${resultRaw}" (1-0 | 0-1 | ½-½, or 1, 0, =, draw, 1/2, 0.5)`);
  }

  const before = pairing.result;
  pairing.result = score;
  if (urlRaw) pairing.game_url = urlRaw;
  pairing.updated_at = new Date().toISOString();
  if (values.swapped) pairing.colors_swapped = true;

  // Say what the pairing now HOLDS, not just what this call passed: an override that omits the
  // url keeps the previous one, and reporting "no game url" there would be a lie.
  const urlNote = urlRaw
    ? ` (${urlRaw})`
    : pairing.game_url
      ? ` (keeping ${pairing.game_url} — use --clear first to drop it)`
      : " (no game url — walkover?)";
  out(`R${roundNo}/b${board} ${who} — ${before ? `${before} → ` : ""}${score}${urlNote}`);
  save(file, t);
  return 0;
}

async function cmdPair(positionals: string[], values: Values): Promise<number> {
  requireArgs(positionals, 1, "pair <slug> [--round N] [--every DAYS]");
  const { t, file } = loadOne(positionals[0]);

  if (t.type === "swiss") {
    // Swiss pairings are made by ChessManager, not by us — we only ingest the pastes.
    const dir = join(TOURNAMENTS_DIR, t.slug);
    if (!existsSync(dir)) {
      throw new UsageError(
        `swiss pairings come from ChessManager pastes; drop them in ${dir}/r<N>.txt first`
      );
    }
    const before = t.rounds.map((r) => `${r.round}:${r.pairings.length}`).join(",");
    const changed = await syncRounds(t, TOURNAMENTS_DIR);
    if (!changed) out("no new round files to ingest");
    else {
      for (const r of [...t.rounds].sort((a, b) => a.round - b.round)) {
        out(`  R${r.round} — ${r.pairings.length} pairing(s), starts ${r.startDate?.slice(0, 10) ?? "?"}`);
      }
      if (before) out(`(was ${before})`);
    }
    save(file, t);
    return 0;
  }

  const roster = (t.players ?? []).map((p) => p.nick);
  if (roster.length < 2) {
    throw new UsageError(`${t.slug} needs at least 2 players — add them with: tourney add ${t.slug} <nick...>`);
  }

  const every = values.every ? Number(values.every) : 0;
  if (values.every && (!Number.isFinite(every) || every < 0)) throw new UsageError("--every must be a number of days");
  const onlyRound = values.round ? Number(values.round) : null;
  if (onlyRound !== null && !Number.isInteger(onlyRound)) throw new UsageError("--round must be an integer");

  const schedule = bergerSchedule(roster, t.type === "double-round-robin");
  const byRound = new Map(t.rounds.map((r) => [r.round, r]));
  let written = 0;
  let skipped = 0;

  schedule.forEach((pairings, i) => {
    const number = i + 1;
    if (onlyRound !== null && number !== onlyRound) return;

    const existing = byRound.get(number);
    const played = existing?.pairings.filter((p) => p.result).length ?? 0;
    if (played && !values.force) {
      out(`  R${number} — skipped, ${played} result(s) already recorded (use --force to regenerate)`);
      skipped++;
      return;
    }

    // Every round starts when the tournament does unless --every spaces them out: in a league
    // where pairs play at their own pace, a narrow window makes the cron miss games.
    //
    // An existing round KEEPS its startDate unless --every is given. `--every` is not stored
    // anywhere, so without this a plain `tourney pair` re-run would silently collapse a spaced
    // schedule back onto the tournament's start date — and a round's startDate is the cron's
    // search-window lower bound, so that is a correctness bug, not a cosmetic one.
    const startDate = every
      ? new Date(Date.parse(t.startDate) + (number - 1) * every * DAY_MS).toISOString()
      : (existing?.startDate ?? t.startDate);
    const round: Round = { round: number, startDate, pairings };

    if (existing) Object.assign(existing, round);
    else t.rounds.push(round);
    written++;

    const desc = pairings.map((p) => (p.black === null ? `${p.white} bye` : `${p.white}–${p.black}`)).join(", ");
    out(`  R${number} — ${pairings.length} board(s): ${desc}`);
  });

  if (onlyRound !== null && !written && !skipped) {
    throw new UsageError(`round ${onlyRound} is outside the schedule (1–${schedule.length})`);
  }

  t.rounds.sort((a, b) => a.round - b.round);
  out(`${written} round(s) generated, ${skipped} skipped, ${schedule.length} in the full schedule`);
  save(file, t);
  return 0;
}

function usage(): void {
  out(`tourney — admin CLI for the tournament manifests in ${TOURNAMENTS_DIR}/

usage: pnpm tourney <command> [args] [--dry-run]

  list                                          every manifest, with status and progress
  status <slug>                                 per-round progress plus data warnings
  players <slug> [--json]                       the roster, in draw order

  init <slug> <type> <platform> [nick...]       scaffold a manifest, optionally with a roster
  add <slug> <nick...>                          look nicks up and append them to the roster
  rm <slug> <nick...>                           remove from the roster (refuses if they play)
  refresh <slug> [nick...]                      re-fetch rating / name / avatar (alias: ratings)

  pair <slug> [--round N] [--every DAYS]        generate pairings (or ingest a swiss paste)
  result <slug> <round> <board> <result> [url]  record a result by hand
  status <slug>                                 what still needs doing

types      swiss | round-robin (rr) | double-round-robin (2rr)
platforms  chesscom (cc) | lichess (li)
results    1-0 | 0-1 | ½-½   also accepted: 1, 0, =, draw, 1/2, 0.5

options
  --dry-run              do everything except write
  --force                overwrite an existing manifest, a played round, or a playing player
  --offline              add nicks without looking them up (fills in later via refresh)
  --players <spec>       extra nicks: a comma list, @file, or - for stdin (one per line, # comments)
  --json                 machine-readable output where it makes sense
  --swapped / --clear    for 'result': mark colours swapped / unset a wrong result
  --round N / --every D  for 'pair': one round only / space rounds D days apart

init also takes --title --organiser --channel --time-control --clock-info --rounds --start --end --cm-url
  --rounds N             how many rounds the event has; display only ("runda 1 / N")

examples
  pnpm tourney init liga2027 2rr cc --organiser matman --clock-info "⌛ 10'+5\\""
  pnpm tourney add liga2027 --players @signups.txt
  pnpm tourney pair liga2027 --every 14
  pnpm tourney result liga2027 3 2 1-0 https://www.chess.com/game/live/123`);
}

// ─── entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return command ? 0 : 1;
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    options: OPTIONS,
    allowPositionals: true,
  });
  const v = values as Values;

  if (v.help) {
    usage();
    return 0;
  }
  DRY_RUN = v["dry-run"] === true;

  switch (command) {
    case "list":
      cmdList();
      return 0;
    case "players":
      cmdPlayers(positionals, v);
      return 0;
    case "status":
      cmdStatus(positionals);
      return 0;
    case "init":
      return await cmdInit(positionals, v);
    case "add":
      return await cmdAdd(positionals, v);
    case "rm":
      return cmdRm(positionals, v);
    case "refresh":
    case "ratings":
      return await cmdRefresh(positionals);
    case "pair":
      return await cmdPair(positionals, v);
    case "result":
      return cmdResult(positionals, v);
    default:
      throw new UsageError(`unknown command "${command}" — run 'pnpm tourney help'`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      process.exitCode = 1;
    } else if (e instanceof PlatformError) {
      console.error(`platform error: ${e.message}`);
      process.exitCode = 2;
    } else {
      console.error(e);
      process.exitCode = 2;
    }
  });
