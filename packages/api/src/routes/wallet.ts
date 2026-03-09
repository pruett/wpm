import { Hono } from "hono";
import type { Transaction, TransferTx, Block } from "@wpm/shared";
import { authMiddleware } from "../middleware/auth";
import type { AuthedEnv } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient, getNodeUrl } from "../node-client";
import { findUserByWallet } from "../db/queries";
import { getUserPrivateKey, signTransaction } from "../crypto/wallet";
import { parseJsonBody, parsePagination, validateAmount, validateExtraFields } from "../validation";

const wallet = new Hono<AuthedEnv>();

wallet.use("*", authMiddleware);

// GET /wallet/balance — proxy to node balance endpoint
wallet.get("/wallet/balance", async (c) => {
  const user = c.get("user");
  const walletAddress = user.walletAddress;

  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  const node = createNodeClient(getNodeUrl());
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

  const { limit, offset } = parsePagination(c, { limit: 50, maxLimit: 200 });

  const node = createNodeClient(getNodeUrl());

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

// POST /wallet/transfer — transfer WPM to another user
wallet.post("/wallet/transfer", async (c) => {
  const user = c.get("user");
  const walletAddress = user.walletAddress;

  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  const body = await parseJsonBody(c);
  if (body instanceof Response) return body;

  const extraErr = validateExtraFields(body, ["recipientAddress", "amount"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { recipientAddress, amount: rawAmount } = body;

  const amountErr = validateAmount(rawAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const amount = rawAmount as number;

  if (typeof recipientAddress !== "string" || !recipientAddress) {
    return sendError(c, "RECIPIENT_NOT_FOUND", "Recipient address is required");
  }

  if (walletAddress === recipientAddress) {
    return sendError(c, "INVALID_TRANSFER", "Cannot transfer to yourself");
  }

  const recipient = findUserByWallet(recipientAddress);
  if (!recipient) {
    return sendError(c, "RECIPIENT_NOT_FOUND");
  }

  let privateKey: string;
  try {
    privateKey = await getUserPrivateKey(user.sub);
  } catch {
    return sendError(c, "INTERNAL_ERROR", "Failed to decrypt wallet key");
  }

  const tx: TransferTx = {
    id: crypto.randomUUID(),
    type: "Transfer",
    timestamp: Date.now(),
    sender: walletAddress,
    signature: "",
    recipient: recipientAddress,
    amount,
  };

  signTransaction(tx, privateKey);

  const node = createNodeClient(getNodeUrl());
  const result = await node.submitTransaction(tx);

  if (!result.ok) {
    const nodeError = result.error;

    if (nodeError.code === "INSUFFICIENT_BALANCE") {
      return sendError(c, "INSUFFICIENT_BALANCE");
    }
    if (nodeError.code === "SELF_TRANSFER") {
      return sendError(c, "INVALID_TRANSFER", "Cannot transfer to yourself");
    }
    if (result.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", nodeError.message);
  }

  return c.json(
    {
      txId: result.data.txId,
      recipient: recipientAddress,
      amount,
      status: "accepted",
    },
    202,
  );
});

function isUserTransaction(tx: Transaction, walletAddress: string): boolean {
  if (tx.sender === walletAddress) return true;
  if ("recipient" in tx && tx.recipient === walletAddress) return true;
  return false;
}

export { wallet };
