/**
 * The `@edopi/cron` replacement — the parts of it a GitHub-Actions cron actually needs.
 *
 * Upstream's `runJob` also offers Redis (`getRedis`, `withLock`), healthchecks.io pings and a
 * pluggable event sink. None of that applies here:
 *  - no lock, because the workflow's `concurrency` group serialises runs (a second run cannot
 *    start while the first is pushing);
 *  - no healthcheck, because a failed Actions run is already visible in the repo's Actions tab;
 *  - no Redis, because the manifests ARE the state — a pairing with a `result` is the dedup.
 *
 * What is kept, name for name, so `cron.ts` diffs against upstream: `Logger`, `RunContext`,
 * `runJob(name, handler, opts)` with its banner and exit-code mapping, and `parseCronArgs`.
 */

export function logInfo(msg: string): void {
  console.log(`ℹ️  ${msg}`);
}

export function logError(msg: string): void {
  console.error(`❌ ${msg}`);
}

export function logWarning(msg: string): void {
  console.warn(`⚠️  ${msg}`);
}

export function logSuccess(msg: string): void {
  console.log(`✅ ${msg}`);
}

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  success: (msg: string) => void;
}

const log: Logger = {
  info: logInfo,
  warn: logWarning,
  error: logError,
  success: logSuccess,
};

export interface RunContext {
  runId: string;
  startedAt: Date;
  dryRun: boolean;
  log: Logger;
}

export interface RunJobOptions {
  /** Mark this run as having no side effects; surfaced on ctx.dryRun. */
  dryRun?: boolean;
}

export interface JobResult {
  ok: boolean;
  skipped: boolean;
  runId: string;
  durationMs: number;
  error?: string;
}

/**
 * Runs a job handler with the standard lifecycle: run id, banner, timing, the `CRON_DISABLED`
 * kill switch, and mapping a thrown error to `process.exitCode = 1` — which is how Actions marks
 * a run failed. Returns a JobResult and never throws.
 */
export async function runJob(
  name: string,
  handler: (ctx: RunContext) => unknown | Promise<unknown>,
  opts: RunJobOptions = {}
): Promise<JobResult> {
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const dryRun = opts.dryRun ?? false;
  const disabled = process.env.CRON_DISABLED === "true";

  const line = "=".repeat(25);
  console.log(`${line} ${startedAt.toISOString()} ${line}`);
  console.log(name);
  console.log(`Run ID:   ${runId}`);
  console.log(`Dry run:  ${dryRun}`);
  console.log(`Disabled: ${disabled}`);
  console.log("");

  if (disabled) {
    log.warn(`[${name}] kill switch active (CRON_DISABLED=true) — skipping run`);
    return { ok: true, skipped: true, runId, durationMs: 0 };
  }

  const t0 = Date.now();
  try {
    await handler({ runId, startedAt, dryRun, log });
    const durationMs = Date.now() - t0;
    log.success(`[${name}] done in ${durationMs}ms`);
    return { ok: true, skipped: false, runId, durationMs };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`[${name}] FAILED after ${durationMs}ms: ${error}`);
    process.exitCode = 1;
    return { ok: false, skipped: false, runId, durationMs, error };
  }
}

export interface CronArgs {
  dryRun: boolean;
}

/** Parses `--dry-run` from argv. (`--from` / `--to` exist upstream; nothing here reads them.) */
export function parseCronArgs(argv: string[] = process.argv.slice(2)): CronArgs {
  return { dryRun: argv.includes("--dry-run") };
}
