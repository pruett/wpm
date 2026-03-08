import { Hono } from "hono";
import type { Block, Transaction } from "@wpm/shared";
import { calculatePrices } from "@wpm/shared/amm";
import { authMiddleware } from "../middleware/auth";
import type { JwtUserPayload } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";
import { findUserByWallet } from "../db/queries";

type Env = {
  Variables: {
    user: JwtUserPayload;
  };
};

const NODE_URL = process.env.NODE_URL ?? "http://localhost:3001";

const markets = new Hono<Env>();

markets.use("/markets/*", authMiddleware);
markets.use("/markets", authMiddleware);

// GET /markets — list open markets with prices, multipliers, and volume
markets.get("/markets", async (c) => {
  const node = createNodeClient(NODE_URL);

  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { markets: allMarkets, pools } = stateResult.data;

  // Filter to open markets
  const openMarkets = Object.values(allMarkets).filter((m) => m.status === "open");

  // Fetch all blocks to compute volume per market
  const volumeByMarket = new Map<string, number>();
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
        if (tx.type === "PlaceBet") {
          const current = volumeByMarket.get(tx.marketId) ?? 0;
          volumeByMarket.set(tx.marketId, current + tx.amount);
        } else if (tx.type === "SellShares") {
          const current = volumeByMarket.get(tx.marketId) ?? 0;
          volumeByMarket.set(tx.marketId, current + tx.shareAmount);
        }
      }
    }

    if (blocks.length < batchSize) break;
    from += blocks.length;
  }

  // Enrich markets with prices, multipliers, and volume
  const enriched = openMarkets.map((market) => {
    const pool = pools[market.marketId];
    const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 };
    const totalVolume = volumeByMarket.get(market.marketId) ?? 0;

    return {
      ...market,
      prices,
      multipliers: {
        multiplierA: prices.priceA > 0 ? Math.round((1 / prices.priceA) * 100) / 100 : 0,
        multiplierB: prices.priceB > 0 ? Math.round((1 / prices.priceB) * 100) / 100 : 0,
      },
      totalVolume,
    };
  });

  return c.json({ markets: enriched });
});

// GET /markets/resolved — list resolved and cancelled markets with pagination
markets.get("/markets/resolved", async (c) => {
  const node = createNodeClient(NODE_URL);

  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { markets: allMarkets } = stateResult.data;

  // Filter to resolved + cancelled markets
  const settled = Object.values(allMarkets).filter(
    (m) => m.status === "resolved" || m.status === "cancelled",
  );

  // Sort by resolvedAt descending (resolved markets), then createdAt descending for cancelled
  settled.sort((a, b) => {
    const timeA = a.resolvedAt ?? a.createdAt;
    const timeB = b.resolvedAt ?? b.createdAt;
    return timeB - timeA;
  });

  // Parse pagination params
  const limitParam = Number(c.req.query("limit") ?? "20");
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitParam) ? limitParam : 20));
  const offsetParam = Number(c.req.query("offset") ?? "0");
  const offset = Math.max(0, Number.isFinite(offsetParam) ? offsetParam : 0);

  const paginated = settled.slice(offset, offset + limit);

  return c.json({
    markets: paginated,
    total: settled.length,
    limit,
    offset,
  });
});

// GET /markets/:marketId — single market with pool details and user position
markets.get("/markets/:marketId", async (c) => {
  const { marketId } = c.req.param();
  const user = c.get("user");
  const node = createNodeClient(NODE_URL);

  // Fetch market + pool + prices from node
  const marketResult = await node.getMarket(marketId);
  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market, pool, prices } = marketResult.data;

  // Fetch user position if they have a wallet
  let userPosition: {
    outcomeA: { shares: number; costBasis: number; estimatedValue: number } | null;
    outcomeB: { shares: number; costBasis: number; estimatedValue: number } | null;
  } | null = null;

  if (user.walletAddress) {
    const sharesResult = await node.getShares(user.walletAddress);
    if (sharesResult.ok) {
      const marketPositions = sharesResult.data.positions[marketId];
      if (marketPositions) {
        const posA = marketPositions["A"];
        const posB = marketPositions["B"];
        userPosition = {
          outcomeA:
            posA && posA.shares > 0
              ? {
                  shares: posA.shares,
                  costBasis: posA.costBasis,
                  estimatedValue: Math.round(posA.shares * prices.priceA * 100) / 100,
                }
              : null,
          outcomeB:
            posB && posB.shares > 0
              ? {
                  shares: posB.shares,
                  costBasis: posB.costBasis,
                  estimatedValue: Math.round(posB.shares * prices.priceB * 100) / 100,
                }
              : null,
        };
        // If both null, set userPosition to null
        if (!userPosition.outcomeA && !userPosition.outcomeB) {
          userPosition = null;
        }
      }
    }
  }

  return c.json({
    market,
    pool: pool ?? null,
    prices,
    userPosition,
  });
});

// GET /markets/:marketId/trades — trade history for a market with user display names
markets.get("/markets/:marketId/trades", async (c) => {
  const { marketId } = c.req.param();
  const node = createNodeClient(NODE_URL);

  // Verify market exists
  const marketResult = await node.getMarket(marketId);
  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  // Parse pagination params
  const limitParam = Number(c.req.query("limit") ?? "20");
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitParam) ? limitParam : 20));
  const offsetParam = Number(c.req.query("offset") ?? "0");
  const offset = Math.max(0, Number.isFinite(offsetParam) ? offsetParam : 0);

  // Fetch all blocks, filter PlaceBet/SellShares for this market
  const trades: (Transaction & { type: "PlaceBet" | "SellShares" })[] = [];
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
        if ((tx.type === "PlaceBet" || tx.type === "SellShares") && tx.marketId === marketId) {
          trades.push(tx as Transaction & { type: "PlaceBet" | "SellShares" });
        }
      }
    }

    if (blocks.length < batchSize) break;
    from += blocks.length;
  }

  // Sort by timestamp descending
  trades.sort((a, b) => b.timestamp - a.timestamp);

  // Build wallet → display name lookup from unique senders
  const walletSet = new Set(trades.map((t) => t.sender));
  const namesByWallet = new Map<string, string>();
  for (const wallet of walletSet) {
    const user = findUserByWallet(wallet);
    if (user) {
      namesByWallet.set(wallet, user.name);
    }
  }

  // Apply pagination
  const paginated = trades.slice(offset, offset + limit);

  // Enrich with display name
  const enriched = paginated.map((tx) => ({
    ...tx,
    userName: namesByWallet.get(tx.sender) ?? null,
  }));

  return c.json({
    trades: enriched,
    total: trades.length,
    limit,
    offset,
  });
});

export { markets };
