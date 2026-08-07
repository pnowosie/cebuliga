/** Footer build stamp: short commit sha + build date. Falls back to the date alone when git
 *  history isn't available (shallow clone, tarball deploy), so a footer never fails a build. */
import { execFileSync } from "node:child_process";

export function buildVersion(): string {
  const date = new Date().toISOString().split("T")[0];
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha ? `${sha} - ${date}` : date;
  } catch {
    return date;
  }
}
