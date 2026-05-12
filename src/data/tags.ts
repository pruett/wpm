import "server-only";

export const tags = {
  market: (id: string) => `market:${id}` as const,
  event: (id: string) => `event:${id}` as const,
  marketsAll: () => "markets" as const,
  eventsAll: () => "events" as const,
  viewer: (userId: string) => `viewer:${userId}` as const,
  leaderboard: () => "leaderboard" as const,
} as const;
