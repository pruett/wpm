import type {
  MarketWithOdds,
  MarketBettor,
  SharePosition,
  CategoryInfo,
  MarketsResponse,
  LeaderboardEntry,
} from "@wpm/shared";

export async function fetchMarkets(fetchFn: typeof fetch = fetch): Promise<MarketsResponse> {
  const res = await fetchFn("/api/markets");
  if (!res.ok) throw new Error(`Failed to fetch markets: ${res.status}`);
  return res.json();
}

export async function fetchCategories(fetchFn: typeof fetch = fetch): Promise<CategoryInfo[]> {
  const res = await fetchFn("/api/categories");
  if (!res.ok) throw new Error(`Failed to fetch categories: ${res.status}`);
  return res.json();
}

export async function fetchCategoryMarkets(
  slug: string,
  fetchFn: typeof fetch = fetch,
): Promise<MarketWithOdds[]> {
  const res = await fetchFn(`/api/categories/${slug}/markets`);
  if (!res.ok) throw new Error(`Failed to fetch category markets: ${res.status}`);
  return res.json();
}

export async function fetchMarketById(
  id: string,
  fetchFn: typeof fetch = fetch,
): Promise<MarketWithOdds> {
  const res = await fetchFn(`/api/markets/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch market: ${res.status}`);
  return res.json();
}

export async function fetchLeaderboard(fetchFn: typeof fetch = fetch): Promise<LeaderboardEntry[]> {
  const res = await fetchFn("/api/leaderboard");
  if (!res.ok) throw new Error(`Failed to fetch leaderboard: ${res.status}`);
  return res.json();
}

export async function fetchMarketBettors(marketId: string): Promise<MarketBettor[]> {
  const res = await fetch(`/api/markets/${encodeURIComponent(marketId)}/bettors`);
  if (!res.ok) throw new Error(`Failed to fetch bettors: ${res.status}`);
  return res.json();
}

export async function fetchPositions(): Promise<SharePosition[]> {
  const res = await fetch("/api/positions");
  if (!res.ok) throw new Error(`Failed to fetch positions: ${res.status}`);
  return res.json();
}

export async function placeBet(
  marketId: string,
  outcome: "A" | "B",
  amount: number,
): Promise<void> {
  const res = await fetch("/api/bet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketId, outcome, amount }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bet failed: ${res.status}`);
  }
}
