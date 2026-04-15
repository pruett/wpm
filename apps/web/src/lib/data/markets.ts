import { cacheLife, cacheTag } from "next/cache";
import type { MarketsResponse } from "@wpm/shared";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export async function getMarkets(): Promise<MarketsResponse> {
  "use cache";
  cacheLife("minutes");
  cacheTag("markets");

  const res = await fetch(`${API_BASE}/api/markets`);
  if (!res.ok) {
    throw new Error(`Failed to fetch markets: ${res.status}`);
  }
  return res.json();
}
