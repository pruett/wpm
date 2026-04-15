import { cacheLife, cacheTag } from "next/cache";
import type { MarketWithOdds } from "@wpm/shared";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export async function getMarket(id: string): Promise<MarketWithOdds> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`market:${id}`);

  const res = await fetch(`${API_BASE}/api/markets/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch market ${id}: ${res.status}`);
  }
  return res.json();
}
