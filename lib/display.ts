/**
 * Presentation helpers shared by the Astro pages. Polish UI strings live here so the
 * templates stay free of hardcoded labels.
 */
import type { Tournament, TournamentType } from "./manifest";

/** Where the tournament manifests live, relative to the repo root (Astro's cwd at build time). */
export const TOURNAMENTS_DIR = "tournaments";

/**
 * A player's profile on the tournament's playzone. The nick is the only identifier we have,
 * and it is exactly what both platforms key their profile URLs on.
 */
export function profileUrl(platform: Tournament["platform"], nick: string): string {
  return platform === "lichess"
    ? `https://lichess.org/@/${encodeURIComponent(nick)}`
    : `https://www.chess.com/member/${encodeURIComponent(nick)}`;
}

/**
 * URL-safe form of a nick, used as the `[nick]` route param. Lowercased so the URL is stable
 * regardless of how the organiser typed it — nicks are compared case-insensitively everywhere.
 */
export function nickSlug(nick: string): string {
  return encodeURIComponent(nick.toLowerCase());
}

/** Our own profile page for a player. Nicks link here first; the playzone is one click further. */
export function playerPageUrl(slug: string, nick: string): string {
  return `/${slug}/gracze/${nickSlug(nick)}`;
}

export function typeLabel(type: TournamentType): string {
  switch (type) {
    case "swiss":
      return "szwajcar";
    case "round-robin":
      return "kołówka";
    case "double-round-robin":
      return "2 kołówka";
  }
}

export function platformLabel(platform: Tournament["platform"]): string {
  return platform === "lichess" ? "lichess.org" : "chess.com";
}

/**
 * What to show where the time control belongs: the organiser's own note when they wrote one,
 * otherwise the perf class the cron works with.
 *
 * `timeControl` cannot carry it — that is the perf class the cron matches games on and the perf
 * `tourney` reads ratings from — hence the separate, display-only `clockInfo`.
 *
 * Rendered VERBATIM, including any leading icon: the organiser picks it, because the field is
 * not always a clock (`⌛ 10'+5"`, but equally `📅 1 dzień`). Nothing is prepended here.
 */
export function clockLabel(t: Tournament): string {
  return t.clockInfo?.trim() || t.timeControl;
}

export type TournamentStatus = "planned" | "running" | "finished";

/**
 * Where the tournament sits on the calendar. Three states — `active` alone cannot express
 * "announced but not started yet", which is exactly when a tournament most needs a page.
 *
 * The dates decide, with one override: `active: false` inside the window means the organiser
 * closed the event early (it also stops the cron polling it), so it reads as finished rather
 * than running. Before the start date `active` is ignored — a tournament is routinely
 * announced with the flag still off.
 *
 * Resolved at BUILD time. The status is therefore as fresh as the last deploy, which is fine
 * while the cron rebuilds on a schedule.
 */
export function tournamentStatus(t: Tournament, now: Date = new Date()): TournamentStatus {
  const start = Date.parse(t.startDate);
  const end = Date.parse(t.endDate);
  const ms = now.getTime();
  if (!isNaN(start) && ms < start) return "planned";
  if (!isNaN(end) && ms > end) return "finished";
  return t.active ? "running" : "finished";
}

export function statusLabel(status: TournamentStatus): string {
  switch (status) {
    case "planned":
      return "planowany";
    case "running":
      return "w trakcie";
    case "finished":
      return "zakończony";
  }
}

/**
 * Polish plural. Three forms: 1 → `one`, 2–4 → `few`, everything else → `many`, with the
 * 12–14 exception ("12 rund", not "12 rundy").
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  if (abs === 1) return one;
  const last = abs % 10;
  const lastTwo = abs % 100;
  return last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14) ? few : many;
}

export const roundsLabel = (n: number) => `${n} ${plural(n, "runda", "rundy", "rund")}`;
export const gamesLabel = (n: number) => `${n} ${plural(n, "partia", "partie", "partii")}`;

/**
 * Whether the pairing's colours were assigned in advance. Only then is a colour swap an
 * anomaly worth flagging — in a single round-robin the playzone draws the colour when the
 * challenge is accepted, so "swapped" is the normal case and the ⚠ would be noise.
 */
export function hasAssignedColors(type: TournamentType): boolean {
  return type !== "round-robin";
}

/** Only swiss tournaments have an info-page so far; round-robin rows stay unlinked. */
export function hasInfoPage(type: TournamentType): boolean {
  return type === "swiss";
}

/**
 * Point totals as plain decimals: 0, 0.5, 1, 1.5, … — never the ½ glyph.
 *
 * Game *results* keep chess notation ("½-½") because that is what the manifest stores and what
 * game-notifier writes; this is only for counting points.
 */
export function formatPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

/** ISO timestamp → "26.04.2026". Returns "" for anything unparseable. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

export function dateRange(t: Tournament): string {
  const from = formatDate(t.startDate);
  const to = formatDate(t.endDate);
  return from && to ? `${from} – ${to}` : from || to;
}

/** Latest round number, or null when the tournament has no rounds yet. */
export function latestRound(t: Tournament): number | null {
  if (!t.rounds.length) return null;
  return Math.max(...t.rounds.map((r) => r.round));
}
