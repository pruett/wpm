import { cacheLife, cacheTag } from "next/cache";
import type { LeaderboardEntry } from "@wpm/shared";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("leaderboard");

  const res = await fetch(`${API_BASE}/api/leaderboard`);
  if (!res.ok) {
    throw new Error(`Failed to fetch leaderboard: ${res.status}`);
  }
  return res.json();
}
