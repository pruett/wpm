import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { CreateMarketTx, PlaceBetTx, ResolveMarketTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14820;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-admin-monitoring";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.ADMIN_API_KEY = "test-admin-api-key-for-monitoring";
const DB_PATH = join(tmpdir(), `wpm-admin-mon-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-admin-mon-${randomUUID()}.jsonl`);

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
const user1Keys = generateKeyPair();
const user2Keys = generateKeyPair();
const user1Id = randomUUID();
const user2Id = randomUUID();

// Set oracle keys for admin endpoints
process.env.ORACLE_PRIVATE_KEY = oracleKeys.privateKey;
process.env.ORACLE_PUBLIC_KEY = oracleKeys.publicKey;

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let adminToken: string;
let userToken: string;

const marketId = randomUUID();
const resolvedMarketId = randomUUID();

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

  // 3. Seed SQLite with users
  const db = getDb();
  const encKey1 = await encryptPrivateKey(user1Keys.privateKey, process.env.WALLET_ENCRYPTION_KEY!);
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user1Id,
    "User One",
    `user1-${randomUUID()}@example.com`,
    user1Keys.publicKey,
    encKey1,
    "user",
    Date.now(),
  );

  const encKey2 = await encryptPrivateKey(user2Keys.privateKey, process.env.WALLET_ENCRYPTION_KEY!);
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user2Id,
    "User Two",
    `user2-${randomUUID()}@example.com`,
    user2Keys.publicKey,
    encKey2,
    "user",
    Date.now(),
  );

  // 4. Distribute funds to users
  await fetch(`http://127.0.0.1:${NODE_PORT}/internal/distribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: user1Keys.publicKey,
      amount: 100000,
      reason: "signup_airdrop",
    }),
  });
  await fetch(`http://127.0.0.1:${NODE_PORT}/internal/distribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: user2Keys.publicKey,
      amount: 50000,
      reason: "referral_reward",
    }),
  });

  // 5. Create markets
  const eventStartTime = Date.now() + 3600_000;
  const createMarket1: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId,
    sport: "NFL",
    homeTeam: "Chiefs",
    awayTeam: "Eagles",
    outcomeA: "Chiefs Win",
    outcomeB: "Eagles Win",
    eventStartTime,
    seedAmount: 10000,
    externalEventId: `ext-${randomUUID()}`,
  };
  createMarket1.signature = sign(
    JSON.stringify({ ...createMarket1, signature: undefined }),
    oracleKeys.privateKey,
  );
  await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createMarket1),
  });

  const createMarket2: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: resolvedMarketId,
    sport: "NBA",
    homeTeam: "Lakers",
    awayTeam: "Celtics",
    outcomeA: "Lakers Win",
    outcomeB: "Celtics Win",
    eventStartTime: Date.now() + 500,
    seedAmount: 5000,
    externalEventId: `ext-${randomUUID()}`,
  };
  createMarket2.signature = sign(
    JSON.stringify({ ...createMarket2, signature: undefined }),
    oracleKeys.privateKey,
  );
  await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createMarket2),
  });

  // Produce block to commit setup
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 6. Place a bet on market1
  const betTx: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now(),
    sender: user1Keys.publicKey,
    signature: "",
    marketId,
    outcome: "A",
    amount: 500,
  };
  betTx.signature = sign(JSON.stringify({ ...betTx, signature: undefined }), user1Keys.privateKey);
  await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(betTx),
  });

  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 7. Resolve market2 — wait for eventStartTime if needed
  await new Promise((r) =>
    setTimeout(r, Math.max(0, createMarket2.eventStartTime - Date.now() + 50)),
  );

  const resolveTx: ResolveMarketTx = {
    id: randomUUID(),
    type: "ResolveMarket",
    timestamp: Math.max(Date.now(), createMarket2.eventStartTime),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: resolvedMarketId,
    winningOutcome: "A",
    finalScore: "110-105",
  };
  resolveTx.signature = sign(
    JSON.stringify({ ...resolveTx, signature: undefined }),
    oracleKeys.privateKey,
  );
  await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resolveTx),
  });

  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 8. Mint tokens
  adminToken = await signJwt({ sub: "admin", role: "admin" as const });
  userToken = await signJwt({
    sub: user1Id,
    role: "user" as const,
    walletAddress: user1Keys.publicKey,
    email: "user1@example.com",
  });

  // 9. Create Hono app with admin routes
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

describe("GET /admin/treasury", () => {
  test("returns treasury balance and aggregates", async () => {
    const res = await app.request("/admin/treasury", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.treasuryAddress).toBe(poaKeys.publicKey);
    expect(typeof body.balance).toBe("number");
    expect(body.balance).toBeGreaterThan(0);
    expect(typeof body.totalDistributed).toBe("number");
    expect(typeof body.totalSeeded).toBe("number");
    expect(typeof body.totalReclaimed).toBe("number");
  });

  test("totalDistributed includes all Distribute tx amounts", async () => {
    const res = await app.request("/admin/treasury", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await res.json();
    // Genesis distribute (1B) + user1 airdrop (100K) + user2 reward (50K)
    // Genesis distribute is the initial supply to treasury — check if genesis Distribute is counted
    // totalDistributed should include: 100000 (user1) + 50000 (user2) + genesis distribute amount
    expect(body.totalDistributed).toBeGreaterThanOrEqual(150000);
  });

  test("totalSeeded includes CreateMarket seedAmounts", async () => {
    const res = await app.request("/admin/treasury", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await res.json();
    // market1: 10000 + market2: 5000 = 15000
    expect(body.totalSeeded).toBeGreaterThanOrEqual(15000);
  });

  test("totalReclaimed includes liquidity_return payouts to treasury", async () => {
    const res = await app.request("/admin/treasury", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await res.json();
    // market2 was resolved — should have liquidity_return payout back to treasury
    expect(body.totalReclaimed).toBeGreaterThan(0);
  });

  test("aggregates are consistent with chain state", async () => {
    const res = await app.request("/admin/treasury", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await res.json();

    // Verify actual treasury balance from node state
    const stateRes = await fetch(
      `http://127.0.0.1:${NODE_PORT}/internal/balance/${encodeURIComponent(poaKeys.publicKey)}`,
    );
    const stateBody = (await stateRes.json()) as { balance: number };
    expect(body.balance).toBe(Math.round(stateBody.balance * 100) / 100);
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/treasury", {
      method: "GET",
      headers: { Authorization: `Bearer ${userToken}` },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/admin/treasury", { method: "GET" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /admin/users", () => {
  test("returns all users with balances from node", async () => {
    const res = await app.request("/admin/users", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.users).toBeArray();
    expect(body.users.length).toBe(2);
  });

  test("user entries have correct fields", async () => {
    const res = await app.request("/admin/users", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await res.json();
    const user1 = body.users.find((u: any) => u.userId === user1Id);
    expect(user1).toBeDefined();
    expect(user1.name).toBe("User One");
    expect(user1.walletAddress).toBe(user1Keys.publicKey);
    expect(user1.role).toBe("user");
    expect(typeof user1.balance).toBe("number");
    expect(typeof user1.createdAt).toBe("number");
    expect(typeof user1.email).toBe("string");
  });

  test("balances match node state", async () => {
    const res = await app.request("/admin/users", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await res.json();
    const user1 = body.users.find((u: any) => u.userId === user1Id);
    const user2 = body.users.find((u: any) => u.userId === user2Id);

    // user1: received 100K airdrop, placed 500 bet → 99500
    expect(user1.balance).toBe(99500);
    // user2: received 50K → 50000
    expect(user2.balance).toBe(50000);
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/users", {
      method: "GET",
      headers: { Authorization: `Bearer ${userToken}` },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/admin/users", { method: "GET" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /admin/health", () => {
  test("returns healthy status when node is reachable", async () => {
    const res = await app.request("/admin/health", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("ok");
    expect(body.apiVersion).toBe("0.0.1");
    expect(typeof body.uptimeMs).toBe("number");
    expect(body.uptimeMs).toBeGreaterThan(0);
    expect(typeof body.connectedSSEClients).toBe("number");
    expect(body.nodeReachable).toBe(true);
    expect(body.node).toBeDefined();
    expect(typeof body.node.blockHeight).toBe("number");
    expect(typeof body.node.mempoolSize).toBe("number");
    expect(typeof body.node.uptimeMs).toBe("number");
  });

  test("health reflects node block height", async () => {
    const res = await app.request("/admin/health", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const body = await res.json();
    // We produced 3 blocks in setup (genesis is block 0, then 3 more = height 4)
    expect(body.node.blockHeight).toBeGreaterThanOrEqual(3);
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request("/admin/health", {
      method: "GET",
      headers: { Authorization: `Bearer ${userToken}` },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/admin/health", { method: "GET" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
