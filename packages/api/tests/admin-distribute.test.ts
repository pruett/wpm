import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { DistributeTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14801;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-admin-distribute";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.ADMIN_API_KEY = "test-admin-api-key-for-distribute";
const DB_PATH = join(tmpdir(), `wpm-admin-dist-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-admin-dist-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { admin } = await import("../src/routes/admin");
const { signJwt } = await import("../src/middleware/auth");
const { encryptPrivateKey } = await import("../src/crypto/wallet");
const { getDb, closeDb } = await import("../src/db/index");

// --- Node internals ---
const { ChainState } = await import("../../node/src/state");
const { createGenesisBlock } = await import("../../node/src/genesis");
const { Mempool } = await import("../../node/src/mempool");
const { startApi: startNodeApi } = await import("../../node/src/api");
const { produceBlock } = await import("../../node/src/producer");
const { EventBus } = await import("../../node/src/events");

// --- Test fixtures ---
const poaKeys = generateKeyPair();
const oracleKeys = generateKeyPair();
const recipientKeys = generateKeyPair();
const recipientId = randomUUID();

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let adminToken: string;
let userToken: string;

beforeAll(async () => {
  // 1. Bootstrap blockchain with genesis
  state = new ChainState(poaKeys.publicKey);
  const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
  state.applyBlock(genesis);

  mempool = new Mempool(oracleKeys.publicKey);
  eventBus = new EventBus();

  // 2. Start node HTTP API
  nodeApi = startNodeApi(
    state,
    mempool,
    { poaPublicKey: poaKeys.publicKey, poaPrivateKey: poaKeys.privateKey },
    NODE_PORT,
    "127.0.0.1",
    eventBus,
  );
  await new Promise<void>((resolve) => {
    if (nodeApi.server.listening) resolve();
    else nodeApi.server.on("listening", resolve);
  });

  // 3. Seed SQLite with a recipient user
  const db = getDb();
  const encKey = await encryptPrivateKey(
    recipientKeys.privateKey,
    process.env.WALLET_ENCRYPTION_KEY!,
  );
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    recipientId,
    "Recipient",
    `recipient-${randomUUID()}@example.com`,
    recipientKeys.publicKey,
    encKey,
    "user",
    Date.now(),
  );

  // 4. Mint tokens
  adminToken = await signJwt({
    sub: "admin",
    role: "admin" as const,
  });

  userToken = await signJwt({
    sub: recipientId,
    role: "user" as const,
    walletAddress: recipientKeys.publicKey,
    email: "recipient@example.com",
  });

  // 5. Create Hono app with admin routes
  app = new Hono();
  app.route("/", admin);
});

afterAll(async () => {
  eventBus.closeAll();
  await nodeApi.close();
  closeDb();
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm", CHAIN_FILE]) {
    try {
      unlinkSync(f);
    } catch {}
  }
});

describe("POST /admin/distribute", () => {
  test("valid distribute succeeds with 202 and correct response shape", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 5000,
        reason: "manual",
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.txId).toBeDefined();
    expect(body.recipient).toBe(recipientKeys.publicKey);
    expect(body.amount).toBe(5000);
    expect(body.reason).toBe("manual");
    expect(body.status).toBe("accepted");
  });

  test("treasury decreases and recipient increases after block production", async () => {
    const treasuryBefore = state.balances.get(poaKeys.publicKey) ?? 0;
    const recipientBefore = state.balances.get(recipientKeys.publicKey) ?? 0;

    // Produce block to commit the distribute from previous test
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    const treasuryAfter = state.balances.get(poaKeys.publicKey) ?? 0;
    const recipientAfter = state.balances.get(recipientKeys.publicKey) ?? 0;

    expect(treasuryAfter).toBe(treasuryBefore - 5000);
    expect(recipientAfter).toBe(recipientBefore + 5000);
  });

  test("accepts signup_airdrop reason", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 100,
        reason: "signup_airdrop",
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.reason).toBe("signup_airdrop");
  });

  test("accepts referral_reward reason", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 50,
        reason: "referral_reward",
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.reason).toBe("referral_reward");
  });

  test("rejects invalid reason", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 100,
        reason: "invalid_reason",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Invalid reason");
  });

  test("rejects genesis reason (admin cannot use genesis)", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 100,
        reason: "genesis",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects missing reason", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 100,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects invalid amount with 3+ decimal places", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 10.123,
        reason: "manual",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects zero amount", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 0,
        reason: "manual",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects missing recipient", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: 100,
        reason: "manual",
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("RECIPIENT_NOT_FOUND");
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 100,
        reason: "manual",
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/admin/distribute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: recipientKeys.publicKey,
        amount: 100,
        reason: "manual",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
