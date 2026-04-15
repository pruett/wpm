import { cacheLife, cacheTag } from "next/cache";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export type UserEntry = {
  userId: string;
  address: string;
  balance: number;
};

export async function getUsers(): Promise<UserEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("users");

  const res = await fetch(`${API_BASE}/api/leaderboard`);
  if (!res.ok) {
    throw new Error(`Failed to fetch users: ${res.status}`);
  }
  return res.json();
}
