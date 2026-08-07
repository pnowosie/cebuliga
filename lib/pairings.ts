/**
 * Parse pairings from text copied off a ChessManager round table.
 * Vendored verbatim from `org/game-notifier/src/lib/pairings.ts` (self-contained: local Pairing type).
 *
 * Each row is tab/space separated: "1.\twhiteNick\t2061\t2.0\t[result?]\tblackNick\t1690\t0.0".
 * Header rows (starting "#") and the trailing "chess:manager" line are skipped; the result column is
 * ignored; "No Opponent" rows are byes (black = null).
 */

export interface ParsedPairing {
  boardNumber: number;
  white: string;
  black: string | null;
}

export function parsePairingsPaste(text: string): ParsedPairing[] {
  const pairings: ParsedPairing[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const boardMatch = line.match(/^(\d+)\.\s/);
    if (!boardMatch) continue;

    const parts = line
      .split(/\t+|\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (parts.length < 2) continue;

    const boardNumber = parseInt(boardMatch[1], 10);
    const white = parts[1];
    if (!white) continue;

    if (/\bNo Opponent\b/i.test(line)) {
      pairings.push({ boardNumber, white, black: null });
      continue;
    }

    // Normal row: tokens after the result land as [..., black, blackRating, blackPts]
    if (parts.length < 7) continue;
    const black = parts[parts.length - 3];
    pairings.push({ boardNumber, white, black });
  }

  return pairings;
}
