import type { MarketWithOdds } from "@wpm/shared";

export async function fetchMarkets(): Promise<MarketWithOdds[]> {
  const res = await fetch("/api/markets");
  if (!res.ok) {
    throw new Error(`Failed to fetch markets: ${res.status}`);
  }
  return res.json();
}
