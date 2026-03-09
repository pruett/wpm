import { Hono } from "hono";
import type { Block, Transaction } from "@wpm/shared";
import { calculatePrices } from "@wpm/shared/amm";
import { authMiddleware } from "../middleware/auth";
import type { AuthedEnv } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient, getNodeUrl } from "../node-client";
import { findUserByWallet } from "../db/queries";
import { round2, parsePagination } from "../validation";

const markets = new Hono<AuthedEnv>();

markets.use("/markets/*", authMiddleware);
markets.use("/markets", authMiddleware);

// GET /markets — list open markets with prices, multipliers, and volume
markets.get("/markets", async (c) => {
  const node = createNodeClient(getNodeUrl());

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
        multiplierA: prices.priceA > 0 ? round2(1 / prices.priceA) : 0,
        multiplierB: prices.priceB > 0 ? round2(1 / prices.priceB) : 0,
      },
      totalVolume,
    };
  });

  return c.json({ markets: enriched });
});

// GET /markets/resolved — list resolved and cancelled markets with pagination
markets.get("/markets/resolved", async (c) => {
  const node = createNodeClient(getNodeUrl());

  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { markets: allMarkets } = stateResult.data;

  const settled = Object.values(allMarkets).filter(
    (m) => m.status === "resolved" || m.status === "cancelled",
  );

  settled.sort((a, b) => {
    const timeA = a.resolvedAt ?? a.createdAt;
    const timeB = b.resolvedAt ?? b.createdAt;
    return timeB - timeA;
  });

  const { limit, offset } = parsePagination(c);

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
  const node = createNodeClient(getNodeUrl());

  const marketResult = await node.getMarket(marketId);
  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market, pool, prices } = marketResult.data;

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
                  estimatedValue: round2(posA.shares * prices.priceA),
                }
              : null,
          outcomeB:
            posB && posB.shares > 0
              ? {
                  shares: posB.shares,
                  costBasis: posB.costBasis,
                  estimatedValue: round2(posB.shares * prices.priceB),
                }
              : null,
        };
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
  const node = createNodeClient(getNodeUrl());

  const marketResult = await node.getMarket(marketId);
  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { limit, offset } = parsePagination(c);

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

  trades.sort((a, b) => b.timestamp - a.timestamp);

  const walletSet = new Set(trades.map((t) => t.sender));
  const namesByWallet = new Map<string, string>();
  for (const wallet of walletSet) {
    const user = findUserByWallet(wallet);
    if (user) {
      namesByWallet.set(wallet, user.name);
    }
  }

  const paginated = trades.slice(offset, offset + limit);

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
