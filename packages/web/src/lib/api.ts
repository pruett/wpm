import type { MarketWithOdds, SharePosition } from "@wpm/shared";
import { auth } from "./stores/auth.svelte.js";

export async function fetchMarkets(): Promise<MarketWithOdds[]> {
  const res = await fetch("/api/markets");
  if (!res.ok) {
    throw new Error(`Failed to fetch markets: ${res.status}`);
  }
  return res.json();
}

export async function register(name: string): Promise<{ token: string; address: string }> {
  const res = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Registration failed: ${res.status}`);
  }
  return res.json();
}

function authHeaders(): HeadersInit {
  return auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
}

export async function fetchPositions(): Promise<SharePosition[]> {
  const res = await fetch("/api/positions", { headers: authHeaders() });
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
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ marketId, outcome, amount }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bet failed: ${res.status}`);
  }
}
