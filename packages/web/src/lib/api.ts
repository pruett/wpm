import type { MarketWithOdds, SharePosition } from "@wpm/shared";

export async function fetchMarkets(): Promise<MarketWithOdds[]> {
  const res = await fetch("/api/markets");
  if (!res.ok) {
    throw new Error(`Failed to fetch markets: ${res.status}`);
  }
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
