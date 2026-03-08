import { Hono } from "hono";
import { sign as cryptoSign } from "@wpm/shared/crypto";
import { calculateBuy, calculateSell, calculatePrices } from "@wpm/shared/amm";
import type { PlaceBetTx } from "@wpm/shared";
import { authMiddleware } from "../middleware/auth";
import type { JwtUserPayload } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";
import { getDb } from "../db/index";
import { decryptPrivateKey } from "../crypto/wallet";

type Env = {
  Variables: {
    user: JwtUserPayload;
  };
};

const NODE_URL = process.env.NODE_URL ?? "http://localhost:3001";

const trading = new Hono<Env>();

trading.use("*", authMiddleware);

trading.post("/markets/:marketId/buy/preview", async (c) => {
  const { marketId } = c.req.param();

  // Parse request body
  let body: { outcome?: unknown; amount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const { outcome, amount } = body;

  // Validate outcome
  if (outcome !== "A" && outcome !== "B") {
    return sendError(c, "INVALID_OUTCOME");
  }

  // Validate amount
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return sendError(c, "INVALID_AMOUNT");
  }

  // Validate ≤ 2 decimal places
  const parts = amount.toString().split(".");
  if (parts[1] && parts[1].length > 2) {
    return sendError(c, "INVALID_AMOUNT", "Amount must have at most 2 decimal places");
  }

  // Validate market exists and is tradeable
  const node = createNodeClient(NODE_URL);
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market, pool } = marketResult.data;

  if (market.status !== "open") {
    if (market.status === "resolved") {
      return sendError(c, "MARKET_ALREADY_RESOLVED");
    }
    return sendError(c, "MARKET_CLOSED");
  }

  if (Date.now() >= market.eventStartTime) {
    return sendError(c, "MARKET_CLOSED");
  }

  // Calculate current prices before the trade
  const currentPrices = calculatePrices(pool);

  // Run AMM buy calculation (read-only — does not modify state)
  const buyResult = calculateBuy(pool, outcome, amount);

  // Calculate new prices from the resulting pool
  const newPrices = calculatePrices(buyResult.pool);

  // Fee is 1% of amount
  const fee = Math.round(amount * 0.01 * 100) / 100;

  // Effective price = amount / sharesReceived
  const effectivePrice =
    buyResult.sharesToUser > 0 ? Math.round((amount / buyResult.sharesToUser) * 100) / 100 : 0;

  // Price impact = absolute change in the purchased outcome's price
  const currentPrice = outcome === "A" ? currentPrices.priceA : currentPrices.priceB;
  const newPrice = outcome === "A" ? newPrices.priceA : newPrices.priceB;
  const priceImpact = Math.round(Math.abs(newPrice - currentPrice) * 100) / 100;

  return c.json({
    sharesReceived: buyResult.sharesToUser,
    effectivePrice,
    priceImpact,
    fee,
    newPriceA: Math.round(newPrices.priceA * 100) / 100,
    newPriceB: Math.round(newPrices.priceB * 100) / 100,
  });
});

trading.post("/markets/:marketId/sell/preview", async (c) => {
  const { marketId } = c.req.param();

  // Parse request body
  let body: { outcome?: unknown; amount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const { outcome, amount } = body;

  // Validate outcome
  if (outcome !== "A" && outcome !== "B") {
    return sendError(c, "INVALID_OUTCOME");
  }

  // Validate amount (share quantity to sell)
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return sendError(c, "INVALID_AMOUNT");
  }

  // Validate ≤ 2 decimal places
  const parts = amount.toString().split(".");
  if (parts[1] && parts[1].length > 2) {
    return sendError(c, "INVALID_AMOUNT", "Amount must have at most 2 decimal places");
  }

  // Validate market exists and is tradeable
  const node = createNodeClient(NODE_URL);
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market, pool } = marketResult.data;

  if (market.status !== "open") {
    if (market.status === "resolved") {
      return sendError(c, "MARKET_ALREADY_RESOLVED");
    }
    return sendError(c, "MARKET_CLOSED");
  }

  if (Date.now() >= market.eventStartTime) {
    return sendError(c, "MARKET_CLOSED");
  }

  // Calculate current prices before the trade
  const currentPrices = calculatePrices(pool);

  // Run AMM sell calculation (read-only — does not modify state)
  const sellResult = calculateSell(pool, outcome, amount);

  // Calculate new prices from the resulting pool
  const newPrices = calculatePrices(sellResult.pool);

  // Compute gross return to derive fee (replicate AMM's constant product formula)
  const grossReturn =
    outcome === "A"
      ? Math.round((pool.sharesB - (pool.sharesA * pool.sharesB) / (pool.sharesA + amount)) * 100) /
        100
      : Math.round((pool.sharesA - (pool.sharesA * pool.sharesB) / (pool.sharesB + amount)) * 100) /
        100;
  const fee = Math.round(grossReturn * 0.01 * 100) / 100;

  // Effective price = wpmReceived / shareAmount
  const effectivePrice = amount > 0 ? Math.round((sellResult.netReturn / amount) * 100) / 100 : 0;

  // Price impact = absolute change in the sold outcome's price
  const currentPrice = outcome === "A" ? currentPrices.priceA : currentPrices.priceB;
  const newPrice = outcome === "A" ? newPrices.priceA : newPrices.priceB;
  const priceImpact = Math.round(Math.abs(newPrice - currentPrice) * 100) / 100;

  return c.json({
    wpmReceived: sellResult.netReturn,
    effectivePrice,
    priceImpact,
    fee,
    newPriceA: Math.round(newPrices.priceA * 100) / 100,
    newPriceB: Math.round(newPrices.priceB * 100) / 100,
  });
});

trading.post("/markets/:marketId/buy", async (c) => {
  const user = c.get("user");
  const { marketId } = c.req.param();

  // Parse request body
  let body: { outcome?: unknown; amount?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  const { outcome, amount } = body;

  // Validate outcome
  if (outcome !== "A" && outcome !== "B") {
    return sendError(c, "INVALID_OUTCOME");
  }

  // Validate amount
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return sendError(c, "INVALID_AMOUNT");
  }

  // Validate ≤ 2 decimal places
  const parts = amount.toString().split(".");
  if (parts[1] && parts[1].length > 2) {
    return sendError(c, "INVALID_AMOUNT", "Amount must have at most 2 decimal places");
  }

  // Require wallet address on JWT
  const walletAddress = user.walletAddress;
  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  // Validate market exists and is tradeable
  const node = createNodeClient(NODE_URL);
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
    return sendError(c, "MARKET_CLOSED");
  }

  if (Date.now() >= market.eventStartTime) {
    return sendError(c, "MARKET_CLOSED");
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

  // Construct PlaceBet transaction
  const tx: PlaceBetTx = {
    id: crypto.randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now(),
    sender: walletAddress,
    signature: "",
    marketId,
    outcome,
    amount,
  };

  // Sign transaction (same pattern as node: sign JSON with signature: undefined)
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = cryptoSign(signData, privateKey);

  // Submit to node
  const result = await node.submitTransaction(tx);

  if (!result.ok) {
    const nodeError = result.error;
    const errorStr = nodeError.error ?? "";

    if (
      errorStr === "INSUFFICIENT_BALANCE" ||
      nodeError.message?.includes("INSUFFICIENT_BALANCE")
    ) {
      return sendError(c, "INSUFFICIENT_BALANCE");
    }
    if (result.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", nodeError.message);
  }

  return c.json(
    {
      txId: result.data.txId,
      marketId,
      outcome,
      amount,
      status: "accepted",
    },
    202,
  );
});

export { trading };
