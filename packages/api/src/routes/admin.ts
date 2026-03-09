import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import { adminMiddleware } from "../middleware/admin";
import type { AdminEnv } from "../middleware/admin";
import { sendError } from "../errors";
import { validateAmount } from "../validation";
import { createNodeClient } from "../node-client";

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

export { admin };
