import { Hono } from "hono";
import { sign as cryptoSign } from "@wpm/shared/crypto";
import type { Transaction, TransferTx, Block } from "@wpm/shared";
import { authMiddleware } from "../middleware/auth";
import type { JwtUserPayload } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";
import { getDb } from "../db/index";
import { findUserByWallet } from "../db/queries";
import { decryptPrivateKey } from "../crypto/wallet";
import { validateAmount } from "../validation";

type Env = {
  Variables: {
    user: JwtUserPayload;
  };
};

function getNodeUrl() {
  return process.env.NODE_URL ?? "http://localhost:3001";
}

const wallet = new Hono<Env>();

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

  // Parse pagination params
  const limitParam = Number(c.req.query("limit") ?? "50");
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitParam) ? limitParam : 50));
  const offsetParam = Number(c.req.query("offset") ?? "0");
  const offset = Math.max(0, Number.isFinite(offsetParam) ? offsetParam : 0);

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

  // Parse request body
  let body: { recipientAddress?: unknown; amount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const { recipientAddress, amount: rawAmount } = body;

  // Validate amount
  const amountErr = validateAmount(rawAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const amount = rawAmount as number;

  // Validate recipientAddress is a string
  if (typeof recipientAddress !== "string" || !recipientAddress) {
    return sendError(c, "RECIPIENT_NOT_FOUND", "Recipient address is required");
  }

  // Validate sender ≠ recipient
  if (walletAddress === recipientAddress) {
    return sendError(c, "INVALID_TRANSFER", "Cannot transfer to yourself");
  }

  // Validate recipient exists (check users table)
  const recipient = findUserByWallet(recipientAddress);
  if (!recipient) {
    return sendError(c, "RECIPIENT_NOT_FOUND");
  }

  // Look up user in DB for encrypted private key
  const db = getDb();
  const row = db.query("SELECT wallet_private_key_enc FROM users WHERE id = ?").get(user.sub) as {
    wallet_private_key_enc: Buffer;
  } | null;

  if (!row) {
    return sendError(c, "UNAUTHORIZED", "User not found");
  }

  // Decrypt private key
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return sendError(c, "INTERNAL_ERROR", "Wallet encryption key not configured");
  }

  let privateKey: string;
  try {
    privateKey = await decryptPrivateKey(row.wallet_private_key_enc, encryptionKey);
  } catch {
    return sendError(c, "INTERNAL_ERROR", "Failed to decrypt wallet key");
  }

  // Construct Transfer transaction
  const tx: TransferTx = {
    id: crypto.randomUUID(),
    type: "Transfer",
    timestamp: Date.now(),
    sender: walletAddress,
    signature: "",
    recipient: recipientAddress,
    amount,
  };

  // Sign transaction
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = cryptoSign(signData, privateKey);

  // Submit to node
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
