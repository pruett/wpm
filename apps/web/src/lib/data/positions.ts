import { cacheLife, cacheTag } from "next/cache";
import type { SharePosition } from "@wpm/shared";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export async function getPositions(userId: string): Promise<SharePosition[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`viewer:${userId}`);

  const walletRes = await fetch(`${API_BASE}/api/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!walletRes.ok) {
    throw new Error(`Failed to fetch wallet for positions: ${walletRes.status}`);
  }
  const { token } = (await walletRes.json()) as { token: string };

  const res = await fetch(`${API_BASE}/api/positions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch positions: ${res.status}`);
  }
  return res.json();
}
