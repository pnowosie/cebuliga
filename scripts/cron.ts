/**
 * The game-notifier cron — `pnpm cron` (add `--dry-run` to find and print without posting).
 *
 * Discovers played tournament games (chess.com / lichess) and announces each result to Discord
 * once. State lives in the committed manifests, NOT a database: a pairing with a `result` is the
 * dedup. Ported from `org/game-notifier/src/cron.ts`, with one structural difference.
 *
 * **The workflow commits, not this script.** Upstream shells out to git (`bun $`) at the end of
 * the run; here the `git add / commit / push` stays in `.github/workflows/refresh.yml`, which is
 * where this repo has always done it and where the Actions token already lives. What the script
 * owns is the commit MESSAGE (`lib/commit.ts`), written to `$COMMIT_MSG_FILE` for the workflow to
 * pass to `git commit -F`. No file, no message: the workflow falls back to a generic one, so a
 * local run needs no setup.
 *
 * Exit codes: 0 ok · 1 something failed — a post, a missing webhook, or an unexpected throw. The
 * manifest is still written and committed for whatever DID post, so nothing announces twice.
 */
import { writeFileSync } from "node:fs";
import { buildCommitMessage } from "../lib/commit";
import { parseCronArgs, runJob } from "../lib/common";
import { notify } from "../lib/notifier";

const { dryRun } = parseCronArgs();
const TOURNAMENTS_DIR = "tournaments";

await runJob(
  "game-notifier",
  async ({ log }) => {
    const { changed, posted, errors } = await notify({ tournamentsDir: TOURNAMENTS_DIR, dryRun, log });

    if (changed) {
      const message = buildCommitMessage(posted);
      const msgFile = process.env.COMMIT_MSG_FILE;
      if (msgFile) {
        writeFileSync(msgFile, message.endsWith("\n") ? message : `${message}\n`);
        log.info(`commit message written to ${msgFile}`);
      } else {
        log.info(`manifests changed — commit message would be:\n${message}`);
      }
    } else {
      log.info("no manifest changes");
    }

    // Safe to throw: every manifest was written inside notify(), before this point, and the
    // workflow's commit step runs on failure too (`if: !cancelled()`). So the run is marked failed
    // — which is the honest outcome — without losing the games that did announce.
    if (errors > 0) throw new Error(`${errors} error(s) this run — see above`);
  },
  { dryRun }
);
