/**
 * Discord webhook poster. Vendored from `org/game-notifier/src/lib/discord.ts` unchanged.
 *
 * The TEMPLATE is deliberately byte-identical to the Forgejo cron's: the same channels have been
 * reading that exact line for months, so a reformat here would look like a different bot. It stays
 * INLINE (no file read — the Actions runner is ephemeral), and any 2xx counts as success
 * (Discord answers 204, a request-bin 200).
 */

export type DiscordTemplateVars = {
  round: string | number;
  board: string | number;
  white: string;
  black: string;
  result: string;
  game_url: string;
  /** Optional suffix after the result (e.g. a color-swap warning). */
  warn?: string;
};

const TEMPLATE =
  "Runda {{round}} #szachownica-{{board}}  @{{white}} vs @{{black}}  **{{result}}**{{warn}}\n{{game_url}}";

function render(template: string, vars: DiscordTemplateVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const v = (vars as Record<string, unknown>)[key];
    return v == null ? "" : String(v);
  });
}

export async function postDelayedGameToDiscord(
  webhookUrl: string,
  vars: DiscordTemplateVars
): Promise<void> {
  const content = render(TEMPLATE, vars).trim();
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`discord webhook ${res.status}: ${text.slice(0, 200)}`);
  }
}

/** What a post will look like — for `--dry-run` output, so the message can be eyeballed. */
export function renderDiscordMessage(vars: DiscordTemplateVars): string {
  return render(TEMPLATE, vars).trim();
}
