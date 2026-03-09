import { Hono } from "hono";
import { calculatePrices, calculateBuy, calculateSell } from "@wpm/shared/amm";
import type { Block, Transaction, AMMPool, SharePosition } from "@wpm/shared";
import { authMiddleware } from "../middleware/auth";
import type { JwtUserPayload } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";
import type { NodeClient } from "../node-client";
import { getAllUsers } from "../db/queries";

type Env = {
  Variables: {
    user: JwtUserPayload;
  };
};

function getNodeUrl() {
  return process.env.NODE_URL ?? "http://localhost:3001";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Returns Monday 00:00:00.000 UTC of the current week
function getWeekStartTimestamp(now?: Date): number {
  const d = now ?? new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysSinceMonday,
    0,
    0,
    0,
    0,
  );
}

// Lightweight chain state replay for computing historical balances/pools/positions
class StateSnapshot {
  balances = new Map<string, number>();
  pools = new Map<string, AMMPool>();
  markets = new Map<string, string>(); // marketId → status
  sharePositions = new Map<string, Map<string, Map<string, SharePosition>>>();
  private treasuryAddress: string;

  constructor(treasuryAddress: string) {
    this.treasuryAddress = treasuryAddress;
  }

  getBalance(address: string): number {
    return this.balances.get(address) ?? 0;
  }

  private credit(address: string, amount: number): void {
    this.balances.set(address, this.getBalance(address) + amount);
  }

  private debit(address: string, amount: number): void {
    this.balances.set(address, this.getBalance(address) - amount);
  }

  getSharePosition(address: string, marketId: string, outcome: string): SharePosition {
    return (
      this.sharePositions.get(address)?.get(marketId)?.get(outcome) ?? { shares: 0, costBasis: 0 }
    );
  }

  private setSharePosition(
    address: string,
    marketId: string,
    outcome: string,
    position: SharePosition,
  ): void {
    if (!this.sharePositions.has(address)) this.sharePositions.set(address, new Map());
    const byAddr = this.sharePositions.get(address)!;
    if (!byAddr.has(marketId)) byAddr.set(marketId, new Map());
    byAddr.get(marketId)!.set(outcome, position);
  }

  applyBlock(block: Block): void {
    const settledMarkets: string[] = [];
    for (const tx of block.transactions) {
      this.applyTransaction(tx);
      if (tx.type === "ResolveMarket" || tx.type === "CancelMarket") {
        settledMarkets.push(tx.marketId);
      }
    }
    for (const marketId of settledMarkets) {
      this.pools.delete(marketId);
      for (const [, byMarket] of this.sharePositions) {
        byMarket.delete(marketId);
      }
    }
  }

  private applyTransaction(tx: Transaction): void {
    switch (tx.type) {
      case "Transfer":
        this.debit(tx.sender, tx.amount);
        this.credit(tx.recipient, tx.amount);
        break;
      case "Distribute":
        if (tx.sender !== tx.recipient) this.debit(tx.sender, tx.amount);
        this.credit(tx.recipient, tx.amount);
        break;
      case "CreateMarket": {
        this.debit(this.treasuryAddress, tx.seedAmount);
        const half = tx.seedAmount / 2;
        this.pools.set(tx.marketId, {
          marketId: tx.marketId,
          sharesA: half,
          sharesB: half,
          k: half * half,
          wpmLocked: tx.seedAmount,
        });
        this.markets.set(tx.marketId, "open");
        break;
      }
      case "PlaceBet": {
        const pool = this.pools.get(tx.marketId)!;
        const result = calculateBuy(pool, tx.outcome, tx.amount);
        this.debit(tx.sender, tx.amount);
        this.pools.set(tx.marketId, result.pool);
        const pos = this.getSharePosition(tx.sender, tx.marketId, tx.outcome);
        this.setSharePosition(tx.sender, tx.marketId, tx.outcome, {
          shares: round2(pos.shares + result.sharesToUser),
          costBasis: round2(pos.costBasis + tx.amount),
        });
        break;
      }
      case "SellShares": {
        const pool = this.pools.get(tx.marketId)!;
        const result = calculateSell(pool, tx.outcome, tx.shareAmount);
        this.credit(tx.sender, result.netReturn);
        this.pools.set(tx.marketId, result.pool);
        const pos = this.getSharePosition(tx.sender, tx.marketId, tx.outcome);
        const costBasisReduction = round2(pos.costBasis * (tx.shareAmount / pos.shares));
        this.setSharePosition(tx.sender, tx.marketId, tx.outcome, {
          shares: round2(pos.shares - tx.shareAmount),
          costBasis: round2(pos.costBasis - costBasisReduction),
        });
        break;
      }
      case "ResolveMarket":
        this.markets.set(tx.marketId, "resolved");
        break;
      case "CancelMarket":
        this.markets.set(tx.marketId, "cancelled");
        break;
      case "SettlePayout": {
        const pool = this.pools.get(tx.marketId);
        if (pool) pool.wpmLocked -= tx.amount;
        this.credit(tx.recipient, tx.amount);
        break;
      }
      case "Referral":
        this.debit(tx.sender, tx.amount);
        this.credit(tx.recipient, tx.amount);
        break;
    }
  }
}

async function fetchAllBlocks(node: NodeClient): Promise<Block[] | null> {
  const allBlocks: Block[] = [];
  let from = 0;
  while (true) {
    const result = await node.getBlocks(from, 50);
    if (!result.ok) return null;
    allBlocks.push(...result.data);
    if (result.data.length < 50) break;
    from += result.data.length;
  }
  return allBlocks;
}

const leaderboard = new Hono<Env>();

leaderboard.use("/leaderboard/*", authMiddleware);

// GET /leaderboard/alltime — ranked list of all users by total WPM (balance + estimated position values)
leaderboard.get("/leaderboard/alltime", async (c) => {
  const node = createNodeClient(getNodeUrl());

  // Fetch node state once for balances, markets, and pools
  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { balances, markets, pools } = stateResult.data;

  // Get all users from SQLite
  const users = getAllUsers();

  // For each user, compute totalWpm = balance + sum of estimated open position values
  const entries: {
    userId: string;
    name: string;
    walletAddress: string;
    balance: number;
    positionValue: number;
    totalWpm: number;
  }[] = [];

  for (const user of users) {
    const balance = balances[user.wallet_address] ?? 0;

    // Fetch share positions for this user
    let positionValue = 0;
    const sharesResult = await node.getShares(user.wallet_address);
    if (sharesResult.ok) {
      for (const [marketId, outcomeMap] of Object.entries(sharesResult.data.positions)) {
        const market = markets[marketId];
        if (!market || market.status !== "open") continue;

        const pool = pools[marketId];
        const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 };

        for (const [outcome, pos] of Object.entries(outcomeMap)) {
          if (pos.shares <= 0) continue;
          const price = outcome === "A" ? prices.priceA : prices.priceB;
          positionValue += pos.shares * price;
        }
      }
    }

    positionValue = Math.round(positionValue * 100) / 100;
    const totalWpm = Math.round((balance + positionValue) * 100) / 100;

    entries.push({
      userId: user.id,
      name: user.name,
      walletAddress: user.wallet_address,
      balance,
      positionValue,
      totalWpm,
    });
  }

  // Sort descending by totalWpm, tiebreak by walletAddress ascending
  entries.sort((a, b) => {
    if (b.totalWpm !== a.totalWpm) return b.totalWpm - a.totalWpm;
    return a.walletAddress.localeCompare(b.walletAddress);
  });

  // Assign 1-indexed ranks
  const rankings = entries.map((entry, i) => ({
    rank: i + 1,
    ...entry,
  }));

  return c.json({ rankings });
});

// GET /leaderboard/weekly — ranked by weekly PnL (Mon 00:00 UTC → now)
leaderboard.get("/leaderboard/weekly", async (c) => {
  const node = createNodeClient(getNodeUrl());

  // 1. Fetch current state for current totalWpm
  const stateResult = await node.getState();
  if (!stateResult.ok) return sendError(c, "NODE_UNAVAILABLE");
  const {
    balances: currentBalances,
    markets: currentMarkets,
    pools: currentPools,
  } = stateResult.data;

  // 2. Fetch all blocks for chain replay
  const allBlocks = await fetchAllBlocks(node);
  if (!allBlocks) return sendError(c, "NODE_UNAVAILABLE");

  // 3. Compute Monday 00:00 UTC boundary
  const weekStart = getWeekStartTimestamp();

  // 4. Replay blocks up to the Monday boundary to get historical state
  // Derive treasury address from genesis block
  const treasuryAddress = allBlocks[0]?.transactions[0]?.sender ?? "";
  const snapshot = new StateSnapshot(treasuryAddress);
  for (const block of allBlocks) {
    if (block.timestamp >= weekStart) break;
    snapshot.applyBlock(block);
  }

  // 5. Get all users
  const users = getAllUsers();

  // 6. Compute current and historical totalWpm per user
  const entries: {
    userId: string;
    name: string;
    walletAddress: string;
    currentTotalWpm: number;
    weekStartTotalWpm: number;
    weeklyPnl: number;
  }[] = [];

  for (const user of users) {
    // Current totalWpm (same logic as alltime)
    const currentBalance = currentBalances[user.wallet_address] ?? 0;
    let currentPositionValue = 0;
    const sharesResult = await node.getShares(user.wallet_address);
    if (sharesResult.ok) {
      for (const [marketId, outcomeMap] of Object.entries(sharesResult.data.positions)) {
        const market = currentMarkets[marketId];
        if (!market || market.status !== "open") continue;
        const pool = currentPools[marketId];
        const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 };
        for (const [outcome, pos] of Object.entries(outcomeMap)) {
          if (pos.shares <= 0) continue;
          const price = outcome === "A" ? prices.priceA : prices.priceB;
          currentPositionValue += pos.shares * price;
        }
      }
    }
    currentPositionValue = round2(currentPositionValue);
    const currentTotalWpm = round2(currentBalance + currentPositionValue);

    // Historical totalWpm at week start from replayed state
    const historicalBalance = snapshot.getBalance(user.wallet_address);
    let historicalPositionValue = 0;
    const historicalPositions = snapshot.sharePositions.get(user.wallet_address);
    if (historicalPositions) {
      for (const [marketId, outcomeMap] of historicalPositions) {
        const marketStatus = snapshot.markets.get(marketId);
        if (marketStatus !== "open") continue;
        const pool = snapshot.pools.get(marketId);
        if (pool) {
          const prices = calculatePrices(pool);
          for (const [outcome, pos] of outcomeMap) {
            if (pos.shares <= 0) continue;
            const price = outcome === "A" ? prices.priceA : prices.priceB;
            historicalPositionValue += pos.shares * price;
          }
        }
      }
    }
    historicalPositionValue = round2(historicalPositionValue);
    const weekStartTotalWpm = round2(historicalBalance + historicalPositionValue);

    const weeklyPnl = round2(currentTotalWpm - weekStartTotalWpm);

    entries.push({
      userId: user.id,
      name: user.name,
      walletAddress: user.wallet_address,
      currentTotalWpm,
      weekStartTotalWpm,
      weeklyPnl,
    });
  }

  // 7. Sort by weeklyPnl descending, tiebreak by walletAddress ascending
  entries.sort((a, b) => {
    if (b.weeklyPnl !== a.weeklyPnl) return b.weeklyPnl - a.weeklyPnl;
    return a.walletAddress.localeCompare(b.walletAddress);
  });

  // 8. Assign 1-indexed ranks
  const rankings = entries.map((entry, i) => ({
    rank: i + 1,
    ...entry,
  }));

  return c.json({ rankings, weekStart });
});

export { leaderboard, getWeekStartTimestamp, StateSnapshot };
