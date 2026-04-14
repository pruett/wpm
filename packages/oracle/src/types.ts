export type GameStatus = "scheduled" | "in_progress" | "completed" | "postponed";

export type Game = {
  readonly espnId: string;
  readonly name: string;
  readonly homeTeam: string;
  readonly awayTeam: string;
  readonly homeLogo: string;
  readonly awayLogo: string;
  readonly leagueLogo: string;
  readonly startTime: string;
  readonly status: GameStatus;
  readonly awayMoneyline?: number;
  readonly homeMoneyline?: number;
};
