import { Hono } from "hono";
import { randomUUID } from "crypto";
import { authMiddleware } from "../middleware/auth";
import { adminMiddleware } from "../middleware/admin";
import type { AdminEnv } from "../middleware/admin";
import { sendError } from "../errors";
import { validateAmount } from "../validation";
import { createNodeClient } from "../node-client";
import {
  insertInviteCode,
  getAllInviteCodes,
  findInviteCode,
  deactivateInviteCode,
  findUserByWallet,
} from "../db/queries";

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

  return c.json({ code, active: false });
});

export { admin };
