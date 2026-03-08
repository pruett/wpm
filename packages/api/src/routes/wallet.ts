import { Hono } from "hono";
import type { Transaction, Block } from "@wpm/shared";
import { authMiddleware } from "../middleware/auth";
import type { JwtUserPayload } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";

type Env = {
  Variables: {
    user: JwtUserPayload;
  };
};

const NODE_URL = process.env.NODE_URL ?? "http://localhost:3001";

const wallet = new Hono<Env>();

wallet.use("*", authMiddleware);

// GET /wallet/balance — proxy to node balance endpoint
wallet.get("/wallet/balance", async (c) => {
  const user = c.get("user");
  const walletAddress = user.walletAddress;

  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  const node = createNodeClient(NODE_URL);
  const result = await node.getBalance(walletAddress);

  if (!result.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  return c.json({
    address: result.data.address,
    balance: result.data.balance,
  });
});

// GET /wallet/transactions — fetch blocks, filter user txs, paginate
wallet.get("/wallet/transactions", async (c) => {
  const user = c.get("user");
  const walletAddress = user.walletAddress;

  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  // Parse pagination params
  const limitParam = Number(c.req.query("limit") ?? "50");
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitParam) ? limitParam : 50));
  const offsetParam = Number(c.req.query("offset") ?? "0");
  const offset = Math.max(0, Number.isFinite(offsetParam) ? offsetParam : 0);

  const node = createNodeClient(NODE_URL);

  // Fetch all blocks from node (paginate through in batches of 100)
  const allTransactions: Transaction[] = [];
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
        if (isUserTransaction(tx, walletAddress)) {
          allTransactions.push(tx);
        }
      }
    }

    if (blocks.length < batchSize) break;
    from += blocks.length;
  }

  // Sort by timestamp descending
  allTransactions.sort((a, b) => b.timestamp - a.timestamp);

  // Apply pagination
  const paginated = allTransactions.slice(offset, offset + limit);

  return c.json({
    transactions: paginated,
    total: allTransactions.length,
    limit,
    offset,
  });
});

function isUserTransaction(tx: Transaction, walletAddress: string): boolean {
  if (tx.sender === walletAddress) return true;
  if ("recipient" in tx && tx.recipient === walletAddress) return true;
  return false;
}

export { wallet };
