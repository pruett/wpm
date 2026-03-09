import { Hono } from "hono";
import { verify } from "@wpm/shared/crypto";
import type { Transaction } from "@wpm/shared";
import { sendError } from "../errors";
import { createNodeClient } from "../node-client";

function getNodeUrl() {
  return process.env.NODE_URL ?? "http://localhost:3001";
}

function getOraclePublicKey(): string | null {
  return process.env.ORACLE_PUBLIC_KEY ?? null;
}

const oracle = new Hono();

// --- POST /oracle/transaction ---
// Validates oracle signature on a pre-signed transaction, then forwards to node

oracle.post("/oracle/transaction", async (c) => {
  const oraclePublicKey = getOraclePublicKey();
  if (!oraclePublicKey) {
    return sendError(c, "INTERNAL_ERROR", "Oracle public key not configured");
  }

  let tx: Transaction;
  try {
    tx = await c.req.json();
  } catch {
    return sendError(c, "INVALID_AMOUNT", "Invalid request body");
  }

  // Validate sender matches oracle public key
  if (!tx || typeof tx !== "object" || !tx.sender || tx.sender !== oraclePublicKey) {
    return sendError(c, "UNAUTHORIZED", "Transaction sender must be the oracle");
  }

  // Validate signature is present
  if (!tx.signature || typeof tx.signature !== "string") {
    return sendError(c, "UNAUTHORIZED", "Transaction signature is required");
  }

  // Verify signature against oracle public key
  const signData = JSON.stringify({ ...tx, signature: undefined });
  const isValid = verify(signData, tx.signature, oraclePublicKey);

  if (!isValid) {
    return sendError(c, "UNAUTHORIZED", "Invalid oracle signature");
  }

  // Forward valid signed transaction to node
  const node = createNodeClient(getNodeUrl());
  const result = await node.submitTransaction(tx);

  if (!result.ok) {
    if (result.status === 503) {
      return sendError(c, "NODE_UNAVAILABLE");
    }
    return sendError(c, "INTERNAL_ERROR", result.error.message);
  }

  return c.json(
    {
      txId: result.data.txId,
      status: "accepted",
    },
    202,
  );
});

// --- GET /oracle/markets ---
// Proxy to node state, filter by ?status= query param (comma-separated)

oracle.get("/oracle/markets", async (c) => {
  const node = createNodeClient(getNodeUrl());
  const stateResult = await node.getState();

  if (!stateResult.ok) {
    return sendError(c, "NODE_UNAVAILABLE");
  }

  const statusParam = c.req.query("status");
  const allMarkets = Object.values(stateResult.data.markets);

  if (!statusParam) {
    return c.json({ markets: allMarkets });
  }

  // Parse comma-separated status values
  const validStatuses = new Set(["open", "resolved", "cancelled"]);
  const requestedStatuses = statusParam
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => validStatuses.has(s));

  if (requestedStatuses.length === 0) {
    return c.json({ markets: [] });
  }

  const filtered = allMarkets.filter((m) => requestedStatuses.includes(m.status));
  return c.json({ markets: filtered });
});

export { oracle };
