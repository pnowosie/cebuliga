/**
 * Build-time route helpers. Every `/[slug]` route derives its paths from the manifests, so
 * adding `tournaments/<slug>.json` is the only step needed to publish a tournament.
 */
import { loadTournaments, type Tournament } from "./manifest";
import { TOURNAMENTS_DIR, hasInfoPage, nickSlug } from "./display";
import { rosterOf } from "./standings";

/** Only tournament types that have an info-page get routes generated. */
export function tournamentsWithPages(): Tournament[] {
  return loadTournaments(TOURNAMENTS_DIR)
    .map(({ tournament }) => tournament)
    .filter((t) => hasInfoPage(t.type));
}

/** `getStaticPaths` for `/[slug]/...` pages. */
export function tournamentPaths() {
  return tournamentsWithPages().map((tournament) => ({
    params: { slug: tournament.slug },
    props: { tournament },
  }));
}

/**
 * `getStaticPaths` for `/[slug]/gracze/[nick]`. Uses `rosterOf`, so a nick that only appears in
 * the pairings (hand-edited manifest, no `players[]` entry) still gets a page — otherwise the
 * pairing tables would link to 404s.
 */
export function playerPaths() {
  return tournamentsWithPages().flatMap((tournament) =>
    rosterOf(tournament).map((nick) => ({
      params: { slug: tournament.slug, nick: nickSlug(nick) },
      props: { tournament, nick },
    }))
  );
}

/** `getStaticPaths` for `/[slug]/rundy/[round]`. */
export function roundPaths() {
  return tournamentsWithPages().flatMap((tournament) =>
    tournament.rounds.map((round) => ({
      params: { slug: tournament.slug, round: String(round.round) },
      props: { tournament, round },
    }))
  );
}
