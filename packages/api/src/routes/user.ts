import { Hono } from "hono";
import type { Block } from "@wpm/shared";
import { calculatePrices } from "@wpm/shared/amm";
import { authMiddleware } from "../middleware/auth";
import type { JwtUserPayload } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";
import { findUserById } from "../db/queries";

type Env = {
  Variables: {
    user: JwtUserPayload;
  };
};

function getNodeUrl() {
  return process.env.NODE_URL ?? "http://localhost:3001";
}

const user = new Hono<Env>();

user.use("/user/*", authMiddleware);

// GET /user/profile — read user profile from SQLite
user.get("/user/profile", async (c) => {
  const jwtUser = c.get("user");

  const row = findUserById(jwtUser.sub);
  if (!row) {
    return sendError(c, "UNAUTHORIZED", "User not found");
  }

  return c.json({
    userId: row.id,
    name: row.name,
    email: row.email,
    walletAddress: row.wallet_address,
    createdAt: row.created_at,
  });
});

// GET /user/positions — open market positions with current valuations
user.get("/user/positions", async (c) => {
  const jwtUser = c.get("user");
  const walletAddress = jwtUser.walletAddress;

  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  const node = createNodeClient(getNodeUrl());

  // Fetch user share positions
  const sharesResult = await node.getShares(walletAddress);
  if (!sharesResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  // Fetch node state for markets and pools
  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { markets, pools } = stateResult.data;
  const positions: {
    marketId: string;
    market: {
      sport: string;
      homeTeam: string;
      awayTeam: string;
      outcomeA: string;
      outcomeB: string;
      eventStartTime: number;
    };
    outcome: string;
    shares: number;
    costBasis: number;
    currentPrice: number;
    estimatedValue: number;
  }[] = [];

  for (const [marketId, outcomeMap] of Object.entries(sharesResult.data.positions)) {
    const market = markets[marketId];
    // Only include positions in open markets
    if (!market || market.status !== "open") continue;

    const pool = pools[marketId];
    const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 };

    for (const [outcome, pos] of Object.entries(outcomeMap)) {
      if (pos.shares <= 0) continue;

      const price = outcome === "A" ? prices.priceA : prices.priceB;
      positions.push({
        marketId,
        market: {
          sport: market.sport,
          homeTeam: market.homeTeam,
          awayTeam: market.awayTeam,
          outcomeA: market.outcomeA,
          outcomeB: market.outcomeB,
          eventStartTime: market.eventStartTime,
        },
        outcome,
        shares: pos.shares,
        costBasis: pos.costBasis,
        currentPrice: Math.round(price * 100) / 100,
        estimatedValue: Math.round(pos.shares * price * 100) / 100,
      });
    }
  }

  return c.json({ positions });
});

// GET /user/history — resolved market history with payout and profit
user.get("/user/history", async (c) => {
  const jwtUser = c.get("user");
  const walletAddress = jwtUser.walletAddress;

  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  const node = createNodeClient(getNodeUrl());

  // Fetch node state for markets
  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { markets } = stateResult.data;

  // Scan all blocks for user's PlaceBet costs and SettlePayout receipts
  // (positions are deleted from state after settlement, so costBasis must come from tx history)
  const costByMarket = new Map<string, number>();
  const payoutsByMarket = new Map<string, number>();
  let from = 0;
  const batchSize = 100;

  while (true) {
    const blocksResult = await node.getBlocks(from, batchSize);
    if (!blocksResult.ok) {
      return sendError(c, "NODE_UNAVAILABLE");
    }

    const blocks: Block[] = blocksResult.data;
    if (blocks.length === 0) break;

    for (const block of blocks) {
      for (const tx of block.transactions) {
        if (tx.type === "PlaceBet" && tx.sender === walletAddress) {
          const current = costByMarket.get(tx.marketId) ?? 0;
          costByMarket.set(tx.marketId, current + tx.amount);
        } else if (
          tx.type === "SettlePayout" &&
          tx.recipient === walletAddress &&
          tx.payoutType !== "liquidity_return"
        ) {
          const current = payoutsByMarket.get(tx.marketId) ?? 0;
          payoutsByMarket.set(tx.marketId, current + tx.amount);
        }
      }
    }

    if (blocks.length < batchSize) break;
    from += blocks.length;
  }

  // Build history entries for resolved/cancelled markets where user placed bets or received payouts
  const involvedMarketIds = new Set<string>([...costByMarket.keys(), ...payoutsByMarket.keys()]);

  const history: {
    marketId: string;
    market: {
      sport: string;
      homeTeam: string;
      awayTeam: string;
      outcomeA: string;
      outcomeB: string;
      status: string;
      winningOutcome?: string;
      finalScore?: string;
      resolvedAt?: number;
    };
    costBasis: number;
    payout: number;
    profit: number;
  }[] = [];

  for (const marketId of involvedMarketIds) {
    const market = markets[marketId];
    if (!market || (market.status !== "resolved" && market.status !== "cancelled")) continue;

    const costBasis = costByMarket.get(marketId) ?? 0;
    const payout = payoutsByMarket.get(marketId) ?? 0;
    const profit = Math.round((payout - costBasis) * 100) / 100;

    history.push({
      marketId,
      market: {
        sport: market.sport,
        homeTeam: market.homeTeam,
        awayTeam: market.awayTeam,
        outcomeA: market.outcomeA,
        outcomeB: market.outcomeB,
        status: market.status,
        winningOutcome: market.winningOutcome,
        finalScore: market.finalScore,
        resolvedAt: market.resolvedAt,
      },
      costBasis,
      payout,
      profit,
    });
  }

  // Sort by resolvedAt descending
  history.sort((a, b) => (b.market.resolvedAt ?? 0) - (a.market.resolvedAt ?? 0));

  return c.json({ history });
});

export { user };
