import { Hono } from "hono";
import { calculatePrices } from "@wpm/shared/amm";
import { authMiddleware } from "../middleware/auth";
import type { JwtUserPayload } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";
import { getAllUsers } from "../db/queries";

type Env = {
  Variables: {
    user: JwtUserPayload;
  };
};

function getNodeUrl() {
  return process.env.NODE_URL ?? "http://localhost:3001";
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

export { leaderboard };
