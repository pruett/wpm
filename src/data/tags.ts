import "server-only";

export const tags = {
  market: (id: string) => `market:${id}` as const,
  marketsAll: () => "markets" as const,
  viewer: (userId: string) => `viewer:${userId}` as const,
  leaderboard: () => "leaderboard" as const,
} as const;
