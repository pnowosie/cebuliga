const UA = "cebuliga-refresh/1.0 (github.com/pnowosie/cebuliga)";

export interface ChessComGame {
  uuid: string;
  url: string;
  time_class: string;
  time_control: string;
  end_time: number;
  white: { username: string; rating: number; result: string };
  black: { username: string; rating: number; result: string };
}

export async function fetchRapidRating(username: string): Promise<number | null> {
  const url = `https://api.chess.com/pub/player/${username}/stats`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  return data?.chess_rapid?.last?.rating ?? null;
}

export async function fetchPlayerMonthGames(
  username: string,
  year: number,
  month: number
): Promise<ChessComGame[]> {
  const mm = String(month).padStart(2, "0");
  const url = `https://api.chess.com/pub/player/${username}/games/${year}/${mm}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const data = (await res.json()) as any;
  return data?.games ?? [];
}
