import { Hono } from "hono";
import { randomUUID } from "crypto";
import { sign as cryptoSign } from "@wpm/shared/crypto";
import type { CancelMarketTx, ResolveMarketTx, CreateMarketTx, Block } from "@wpm/shared";
import { authMiddleware } from "../middleware/auth";
import { adminMiddleware } from "../middleware/admin";
import type { AdminEnv } from "../middleware/admin";
import { sendError } from "../errors";
import { validateAmount, validateOutcome, validateExtraFields } from "../validation";
import { createNodeClient } from "../node-client";
import type { NodeClient } from "../node-client";
import {
  insertInviteCode,
  getAllInviteCodes,
  findInviteCode,
  deactivateInviteCode,
  findUserByWallet,
  getAllUsers,
} from "../db/queries";
import { getRelay } from "../sse/relay";
import { audit } from "../logger";

const VALID_REASONS = new Set(["signup_airdrop", "referral_reward", "manual"]);

function getNodeUrl() {
  return process.env.NODE_URL ?? "http://localhost:3001";
}

const admin = new Hono<AdminEnv>();

admin.use("/admin/*", authMiddleware);

admin.post("/admin/distribute", adminMiddleware, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const extraErr = validateExtraFields(body, ["recipient", "amount", "reason"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { recipient: rawRecipient, amount: rawAmount, reason: rawReason } = body;

  // Validate amount
  const amountErr = validateAmount(rawAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const amount = rawAmount as number;

  // Validate recipient is a non-empty string
  if (typeof rawRecipient !== "string" || !rawRecipient) {
    return sendError(c, "RECIPIENT_NOT_FOUND", "Recipient address is required");
  }
  const recipient = rawRecipient;

  // Validate reason
  if (typeof rawReason !== "string" || !VALID_REASONS.has(rawReason)) {
    return sendError(
      c,
      "INVALID_AMOUNT",
      `Invalid reason. Must be one of: ${[...VALID_REASONS].join(", ")}`,
    );
  }
  const reason = rawReason;

  // Call node distribute endpoint
  const node = createNodeClient(getNodeUrl());
  const result = await node.distribute(recipient, amount, reason);

  if (!result.ok) {
    if (result.error.code === "INSUFFICIENT_BALANCE") {
      return sendError(c, "INSUFFICIENT_BALANCE", "Treasury has insufficient balance");
    }
    if (result.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", result.error.message);
  }

  audit("admin.distribute", {
    admin: c.get("user").sub,
    recipient,
    amount,
    reason,
    txId: result.data.txId,
  });

  return c.json(
    {
      txId: result.data.txId,
      recipient,
      amount,
      reason,
      status: "accepted",
    },
    202,
  );
});

// --- Invite Code Management (FR-13) ---

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function generateCode(): string {
  let code = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 8; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

admin.post("/admin/invite-codes", adminMiddleware, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const extraErr = validateExtraFields(body, ["count", "maxUses", "referrer"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { count: rawCount, maxUses: rawMaxUses, referrer: rawReferrer } = body;

  // Validate count
  if (
    typeof rawCount !== "number" ||
    !Number.isInteger(rawCount) ||
    rawCount < 1 ||
    rawCount > 100
  ) {
    return sendError(c, "INVALID_AMOUNT", "count must be an integer between 1 and 100");
  }
  const count = rawCount;

  // Validate maxUses
  if (typeof rawMaxUses !== "number" || !Number.isInteger(rawMaxUses) || rawMaxUses < 1) {
    return sendError(c, "INVALID_AMOUNT", "maxUses must be a positive integer");
  }
  const maxUses = rawMaxUses;

  // Validate optional referrer (must be an existing wallet if provided)
  let referrer: string | null = null;
  if (rawReferrer !== undefined && rawReferrer !== null) {
    if (typeof rawReferrer !== "string" || !rawReferrer) {
      return sendError(c, "INVALID_AMOUNT", "referrer must be a valid wallet address");
    }
    const referrerUser = findUserByWallet(rawReferrer);
    if (!referrerUser) {
      return sendError(c, "RECIPIENT_NOT_FOUND", "Referrer wallet address not found");
    }
    referrer = rawReferrer;
  }

  // Generate unique codes
  const codes: string[] = [];
  const existingCodes = new Set<string>();
  while (codes.length < count) {
    const code = generateCode();
    if (!existingCodes.has(code) && !findInviteCode(code)) {
      codes.push(code);
      existingCodes.add(code);
      insertInviteCode({
        code,
        createdBy: "admin",
        referrer,
        maxUses,
      });
    }
  }

  audit("admin.invite-codes.create", {
    admin: c.get("user").sub,
    count,
    maxUses,
    referrer,
  });

  return c.json({ codes }, 201);
});

admin.get("/admin/invite-codes", adminMiddleware, async (c) => {
  const codes = getAllInviteCodes();
  return c.json({
    inviteCodes: codes.map((row) => ({
      code: row.code,
      createdBy: row.created_by,
      referrer: row.referrer,
      maxUses: row.max_uses,
      useCount: row.use_count,
      active: row.active === 1,
      createdAt: row.created_at,
    })),
  });
});

admin.delete("/admin/invite-codes/:code", adminMiddleware, async (c) => {
  const code = c.req.param("code");

  const existing = findInviteCode(code);
  if (!existing) {
    return sendError(c, "MARKET_NOT_FOUND", "Invite code not found", 404);
  }

  if (existing.active === 0) {
    return c.json({ code, active: false, message: "Already deactivated" });
  }

  deactivateInviteCode(code);

  audit("admin.invite-codes.delete", {
    admin: c.get("user").sub,
    code,
  });

  return c.json({ code, active: false });
});

// --- Market Operations (FR-14) ---

function getOraclePrivateKey(): string | null {
  return process.env.ORACLE_PRIVATE_KEY ?? null;
}

function getOraclePublicKey(): string | null {
  return process.env.ORACLE_PUBLIC_KEY ?? null;
}

async function fetchAllBlocks(node: NodeClient): Promise<Block[]> {
  const allBlocks: Block[] = [];
  let from = 0;
  const batchSize = 50;
  while (true) {
    const result = await node.getBlocks(from, batchSize);
    if (!result.ok) break;
    allBlocks.push(...result.data);
    if (result.data.length < batchSize) break;
    from += batchSize;
  }
  return allBlocks;
}

admin.post("/admin/markets/:marketId/cancel", adminMiddleware, async (c) => {
  const { marketId } = c.req.param();

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const extraErr = validateExtraFields(body, ["reason"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { reason: rawReason } = body;

  if (typeof rawReason !== "string" || !rawReason.trim()) {
    return sendError(c, "INVALID_AMOUNT", "reason is required");
  }
  const reason = rawReason.trim();

  const oraclePrivateKey = getOraclePrivateKey();
  const oraclePublicKey = getOraclePublicKey();
  if (!oraclePrivateKey || !oraclePublicKey) {
    return sendError(c, "INTERNAL_ERROR", "Oracle keys not configured");
  }

  // Validate market exists and is open
  const node = createNodeClient(getNodeUrl());
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market } = marketResult.data;
  if (market.status !== "open") {
    if (market.status === "resolved") {
      return sendError(c, "MARKET_ALREADY_RESOLVED");
    }
    return sendError(c, "MARKET_CLOSED", "Market is already cancelled");
  }

  // Construct CancelMarket transaction signed by oracle
  const tx: CancelMarketTx = {
    id: randomUUID(),
    type: "CancelMarket",
    timestamp: Date.now(),
    sender: oraclePublicKey,
    signature: "",
    marketId,
    reason,
  };

  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = cryptoSign(signData, oraclePrivateKey);

  const result = await node.submitTransaction(tx);

  if (!result.ok) {
    if (result.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", result.error.message);
  }

  audit("admin.market.cancel", {
    admin: c.get("user").sub,
    marketId,
    reason,
    txId: result.data.txId,
  });

  return c.json(
    {
      txId: result.data.txId,
      marketId,
      status: "accepted",
    },
    202,
  );
});

admin.post("/admin/markets/:marketId/resolve", adminMiddleware, async (c) => {
  const { marketId } = c.req.param();

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const extraErr = validateExtraFields(body, ["winningOutcome", "finalScore"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { winningOutcome: rawOutcome, finalScore: rawScore } = body;

  if (!validateOutcome(rawOutcome)) {
    return sendError(c, "INVALID_OUTCOME");
  }
  const winningOutcome = rawOutcome;

  if (typeof rawScore !== "string" || !rawScore.trim()) {
    return sendError(c, "INVALID_AMOUNT", "finalScore is required");
  }
  const finalScore = rawScore.trim();

  const oraclePrivateKey = getOraclePrivateKey();
  const oraclePublicKey = getOraclePublicKey();
  if (!oraclePrivateKey || !oraclePublicKey) {
    return sendError(c, "INTERNAL_ERROR", "Oracle keys not configured");
  }

  // Validate market exists and is open
  const node = createNodeClient(getNodeUrl());
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market } = marketResult.data;
  if (market.status !== "open") {
    if (market.status === "resolved") {
      return sendError(c, "MARKET_ALREADY_RESOLVED");
    }
    return sendError(c, "MARKET_CLOSED", "Market is already cancelled");
  }

  // Construct ResolveMarket transaction signed by oracle
  const tx: ResolveMarketTx = {
    id: randomUUID(),
    type: "ResolveMarket",
    timestamp: Math.max(Date.now(), market.eventStartTime),
    sender: oraclePublicKey,
    signature: "",
    marketId,
    winningOutcome,
    finalScore,
  };

  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = cryptoSign(signData, oraclePrivateKey);

  const result = await node.submitTransaction(tx);

  if (!result.ok) {
    if (result.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", result.error.message);
  }

  audit("admin.market.resolve", {
    admin: c.get("user").sub,
    marketId,
    winningOutcome,
    finalScore,
    txId: result.data.txId,
  });

  return c.json(
    {
      txId: result.data.txId,
      marketId,
      winningOutcome,
      status: "accepted",
    },
    202,
  );
});

admin.post("/admin/markets/:marketId/seed", adminMiddleware, async (c) => {
  const { marketId } = c.req.param();

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const extraErr = validateExtraFields(body, ["seedAmount"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { seedAmount: rawSeedAmount } = body;

  const amountErr = validateAmount(rawSeedAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const seedAmount = rawSeedAmount as number;

  const oraclePrivateKey = getOraclePrivateKey();
  const oraclePublicKey = getOraclePublicKey();
  if (!oraclePrivateKey || !oraclePublicKey) {
    return sendError(c, "INTERNAL_ERROR", "Oracle keys not configured");
  }

  // Validate market exists and is open
  const node = createNodeClient(getNodeUrl());
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market } = marketResult.data;
  if (market.status !== "open") {
    if (market.status === "resolved") {
      return sendError(c, "MARKET_ALREADY_RESOLVED");
    }
    return sendError(c, "MARKET_CLOSED", "Market is already cancelled");
  }

  // Check for existing trades (PlaceBet/SellShares) on this market
  const blocks = await fetchAllBlocks(node);
  const hasTrades = blocks.some((block) =>
    block.transactions.some(
      (tx) => (tx.type === "PlaceBet" || tx.type === "SellShares") && tx.marketId === marketId,
    ),
  );

  if (hasTrades) {
    return sendError(c, "MARKET_HAS_TRADES");
  }

  // Cancel existing market
  const cancelTx: CancelMarketTx = {
    id: randomUUID(),
    type: "CancelMarket",
    timestamp: Date.now(),
    sender: oraclePublicKey,
    signature: "",
    marketId,
    reason: "Seed override",
  };

  const cancelSignData = JSON.stringify({ ...cancelTx, signature: undefined });
  cancelTx.signature = cryptoSign(cancelSignData, oraclePrivateKey);

  const cancelResult = await node.submitTransaction(cancelTx);
  if (!cancelResult.ok) {
    if (cancelResult.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", cancelResult.error.message);
  }

  // Create new market with new marketId and externalEventId, same params, new seed
  const newMarketId = randomUUID();
  const newExternalEventId = `${market.externalEventId}-reseed-${randomUUID().slice(0, 8)}`;

  const createTx: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oraclePublicKey,
    signature: "",
    marketId: newMarketId,
    sport: market.sport,
    homeTeam: market.homeTeam,
    awayTeam: market.awayTeam,
    outcomeA: market.outcomeA,
    outcomeB: market.outcomeB,
    eventStartTime: market.eventStartTime,
    seedAmount,
    externalEventId: newExternalEventId,
  };

  const createSignData = JSON.stringify({ ...createTx, signature: undefined });
  createTx.signature = cryptoSign(createSignData, oraclePrivateKey);

  const createResult = await node.submitTransaction(createTx);
  if (!createResult.ok) {
    if (createResult.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", createResult.error.message);
  }

  audit("admin.market.seed", {
    admin: c.get("user").sub,
    oldMarketId: marketId,
    newMarketId,
    seedAmount,
    cancelTxId: cancelResult.data.txId,
    createTxId: createResult.data.txId,
  });

  return c.json(
    {
      cancelTxId: cancelResult.data.txId,
      createTxId: createResult.data.txId,
      oldMarketId: marketId,
      newMarketId,
      seedAmount,
      status: "accepted",
    },
    202,
  );
});

// --- System Monitoring (FR-15) ---

admin.get("/admin/treasury", adminMiddleware, async (c) => {
  const node = createNodeClient(getNodeUrl());

  // Get treasury address from genesis block (first tx sender = PoA/treasury)
  const genesisResult = await node.getBlock(0);
  if (!genesisResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }
  const treasuryAddress = genesisResult.data.transactions[0].sender;

  // Get current treasury balance from state
  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }
  const balance = stateResult.data.balances[treasuryAddress] ?? 0;

  // Scan all blocks for aggregate computations
  const blocks = await fetchAllBlocks(node);

  let totalDistributed = 0;
  let totalSeeded = 0;
  let totalReclaimed = 0;

  for (const block of blocks) {
    for (const tx of block.transactions) {
      if (tx.type === "Distribute") {
        totalDistributed += tx.amount;
      } else if (tx.type === "CreateMarket") {
        totalSeeded += tx.seedAmount;
      } else if (
        tx.type === "SettlePayout" &&
        tx.payoutType === "liquidity_return" &&
        tx.recipient === treasuryAddress
      ) {
        totalReclaimed += tx.amount;
      }
    }
  }

  return c.json({
    treasuryAddress,
    balance: Math.round(balance * 100) / 100,
    totalDistributed: Math.round(totalDistributed * 100) / 100,
    totalSeeded: Math.round(totalSeeded * 100) / 100,
    totalReclaimed: Math.round(totalReclaimed * 100) / 100,
  });
});

admin.get("/admin/users", adminMiddleware, async (c) => {
  const node = createNodeClient(getNodeUrl());

  // Get balances from node state
  const stateResult = await node.getState();
  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const users = getAllUsers();

  const enrichedUsers = users.map((user) => ({
    userId: user.id,
    name: user.name,
    email: user.email,
    walletAddress: user.wallet_address,
    role: user.role,
    balance: stateResult.data.balances[user.wallet_address] ?? 0,
    createdAt: user.created_at,
  }));

  return c.json({ users: enrichedUsers });
});

admin.get("/admin/health", adminMiddleware, async (c) => {
  const node = createNodeClient(getNodeUrl());

  const nodeResult = await node.getHealth();

  let sseClients = 0;
  try {
    sseClients = getRelay().connectedClients;
  } catch {
    // relay not initialized
  }

  const apiVersion = "0.0.1";

  if (!nodeResult.ok) {
    return c.json({
      status: "degraded",
      apiVersion,
      uptimeMs: process.uptime() * 1000,
      connectedSSEClients: sseClients,
      nodeReachable: false,
    });
  }

  return c.json({
    status: "ok",
    apiVersion,
    uptimeMs: process.uptime() * 1000,
    connectedSSEClients: sseClients,
    nodeReachable: true,
    node: {
      blockHeight: nodeResult.data.blockHeight,
      mempoolSize: nodeResult.data.mempoolSize,
      uptimeMs: nodeResult.data.uptimeMs,
    },
  });
});

// --- Oracle Triggers (FR-16) ---

function getOracleUrl(): string {
  return process.env.ORACLE_URL ?? "http://wpm-oracle:3001";
}

admin.post("/admin/oracle/ingest", adminMiddleware, async (c) => {
  const oracleUrl = getOracleUrl();

  audit("admin.oracle.ingest", { admin: c.get("user").sub });

  try {
    const res = await fetch(`${oracleUrl}/trigger/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json();

    if (!res.ok) {
      return c.json(data, res.status as 400 | 500);
    }

    return c.json(data);
  } catch {
    return sendError(c, "NODE_UNAVAILABLE", "Oracle server is unreachable");
  }
});

admin.post("/admin/oracle/resolve", adminMiddleware, async (c) => {
  const oracleUrl = getOracleUrl();

  audit("admin.oracle.resolve", { admin: c.get("user").sub });

  try {
    const res = await fetch(`${oracleUrl}/trigger/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json();

    if (!res.ok) {
      return c.json(data, res.status as 400 | 500);
    }

    return c.json(data);
  } catch {
    return sendError(c, "NODE_UNAVAILABLE", "Oracle server is unreachable");
  }
});

export { admin };
