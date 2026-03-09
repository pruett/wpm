import { Hono } from "hono";
import { calculateBuy, calculateSell, calculatePrices } from "@wpm/shared/amm";
import type { PlaceBetTx, SellSharesTx } from "@wpm/shared";
import { authMiddleware } from "../middleware/auth";
import type { AuthedEnv } from "../middleware/auth";
import { sendError } from "../errors";
import { createNodeClient, getNodeUrl } from "../node-client";
import { getUserPrivateKey, signTransaction } from "../crypto/wallet";
import {
  round2,
  parseJsonBody,
  validateAmount,
  validateOutcome,
  validateMarketTradeable,
  validateExtraFields,
} from "../validation";

const trading = new Hono<AuthedEnv>();

trading.use("*", authMiddleware);

trading.post("/markets/:marketId/buy/preview", async (c) => {
  const { marketId } = c.req.param();

  const body = await parseJsonBody(c);
  if (body instanceof Response) return body;

  const extraErr = validateExtraFields(body, ["outcome", "amount"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { outcome, amount: rawAmount } = body;

  if (!validateOutcome(outcome)) {
    return sendError(c, "INVALID_OUTCOME");
  }

  const amountErr = validateAmount(rawAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const amount = rawAmount as number;

  const node = createNodeClient(getNodeUrl());
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market, pool } = marketResult.data;

  const marketErr = validateMarketTradeable(market);
  if (marketErr) {
    return sendError(c, marketErr);
  }

  const currentPrices = calculatePrices(pool);
  const buyResult = calculateBuy(pool, outcome, amount);
  const newPrices = calculatePrices(buyResult.pool);

  const fee = round2(amount * 0.01);
  const effectivePrice = buyResult.sharesToUser > 0 ? round2(amount / buyResult.sharesToUser) : 0;

  const currentPrice = outcome === "A" ? currentPrices.priceA : currentPrices.priceB;
  const newPrice = outcome === "A" ? newPrices.priceA : newPrices.priceB;
  const priceImpact = round2(Math.abs(newPrice - currentPrice));

  return c.json({
    sharesReceived: buyResult.sharesToUser,
    effectivePrice,
    priceImpact,
    fee,
    newPriceA: round2(newPrices.priceA),
    newPriceB: round2(newPrices.priceB),
  });
});

trading.post("/markets/:marketId/sell/preview", async (c) => {
  const { marketId } = c.req.param();

  const body = await parseJsonBody(c);
  if (body instanceof Response) return body;

  const extraErr = validateExtraFields(body, ["outcome", "amount"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { outcome, amount: rawAmount } = body;

  if (!validateOutcome(outcome)) {
    return sendError(c, "INVALID_OUTCOME");
  }

  const amountErr = validateAmount(rawAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const amount = rawAmount as number;

  const node = createNodeClient(getNodeUrl());
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market, pool } = marketResult.data;

  const marketErr = validateMarketTradeable(market);
  if (marketErr) {
    return sendError(c, marketErr);
  }

  const currentPrices = calculatePrices(pool);
  const sellResult = calculateSell(pool, outcome, amount);
  const newPrices = calculatePrices(sellResult.pool);

  const grossReturn =
    outcome === "A"
      ? round2(pool.sharesB - (pool.sharesA * pool.sharesB) / (pool.sharesA + amount))
      : round2(pool.sharesA - (pool.sharesA * pool.sharesB) / (pool.sharesB + amount));
  const fee = round2(grossReturn * 0.01);

  const effectivePrice = amount > 0 ? round2(sellResult.netReturn / amount) : 0;

  const currentPrice = outcome === "A" ? currentPrices.priceA : currentPrices.priceB;
  const newPrice = outcome === "A" ? newPrices.priceA : newPrices.priceB;
  const priceImpact = round2(Math.abs(newPrice - currentPrice));

  return c.json({
    wpmReceived: sellResult.netReturn,
    effectivePrice,
    priceImpact,
    fee,
    newPriceA: round2(newPrices.priceA),
    newPriceB: round2(newPrices.priceB),
  });
});

trading.post("/markets/:marketId/buy", async (c) => {
  const user = c.get("user");
  const { marketId } = c.req.param();

  const body = await parseJsonBody(c);
  if (body instanceof Response) return body;

  const extraErr = validateExtraFields(body, ["outcome", "amount"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { outcome, amount: rawAmount } = body;

  if (!validateOutcome(outcome)) {
    return sendError(c, "INVALID_OUTCOME");
  }

  const amountErr = validateAmount(rawAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const amount = rawAmount as number;

  const walletAddress = user.walletAddress;
  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  const node = createNodeClient(getNodeUrl());
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market } = marketResult.data;

  const marketErr = validateMarketTradeable(market);
  if (marketErr) {
    return sendError(c, marketErr);
  }

  let privateKey: string;
  try {
    privateKey = await getUserPrivateKey(user.sub);
  } catch {
    return sendError(c, "INTERNAL_ERROR", "Failed to decrypt wallet key");
  }

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

  signTransaction(tx, privateKey);

  const result = await node.submitTransaction(tx);

  if (!result.ok) {
    const nodeError = result.error;

    if (nodeError.code === "INSUFFICIENT_BALANCE") {
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

trading.post("/markets/:marketId/sell", async (c) => {
  const user = c.get("user");
  const { marketId } = c.req.param();

  const body = await parseJsonBody(c);
  if (body instanceof Response) return body;

  const extraErr = validateExtraFields(body, ["outcome", "amount"]);
  if (extraErr) {
    return sendError(c, "VALIDATION_ERROR", extraErr);
  }

  const { outcome, amount: rawAmount } = body;

  if (!validateOutcome(outcome)) {
    return sendError(c, "INVALID_OUTCOME");
  }

  const amountErr = validateAmount(rawAmount);
  if (amountErr) {
    return sendError(c, amountErr);
  }
  const amount = rawAmount as number;

  const walletAddress = user.walletAddress;
  if (!walletAddress) {
    return sendError(c, "UNAUTHORIZED", "Token missing wallet address");
  }

  const node = createNodeClient(getNodeUrl());
  const marketResult = await node.getMarket(marketId);

  if (!marketResult.ok) {
    if (marketResult.status === 404) {
      return sendError(c, "MARKET_NOT_FOUND");
    }
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const { market } = marketResult.data;

  const marketErr = validateMarketTradeable(market);
  if (marketErr) {
    return sendError(c, marketErr);
  }

  // Validate user holds sufficient shares
  const sharesResult = await node.getShares(walletAddress);

  if (!sharesResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const marketPositions = sharesResult.data.positions[marketId];
  const position = marketPositions?.[outcome];
  const heldShares = position?.shares ?? 0;

  if (heldShares < amount) {
    return sendError(c, "INSUFFICIENT_SHARES");
  }

  let privateKey: string;
  try {
    privateKey = await getUserPrivateKey(user.sub);
  } catch {
    return sendError(c, "INTERNAL_ERROR", "Failed to decrypt wallet key");
  }

  const tx: SellSharesTx = {
    id: crypto.randomUUID(),
    type: "SellShares",
    timestamp: Date.now(),
    sender: walletAddress,
    signature: "",
    marketId,
    outcome,
    shareAmount: amount,
  };

  signTransaction(tx, privateKey);

  const result = await node.submitTransaction(tx);

  if (!result.ok) {
    const nodeError = result.error;

    if (nodeError.code === "INSUFFICIENT_SHARES") {
      return sendError(c, "INSUFFICIENT_SHARES");
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
      shareAmount: amount,
      status: "accepted",
    },
    202,
  );
});

export { trading };
