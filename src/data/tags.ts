import "server-only";

export const tags = {
  market: (id: string) => `market:${id}` as const,
  marketsAll: () => "markets" as const,
  viewer: (userId: string) => `viewer:${userId}` as const,
  leaderboard: () => "leaderboard" as const,
  users: () => "users" as const,
  health: () => "health" as const,
  oracleHeartbeats: () => "oracle-heartbeats" as const,
} as const;
