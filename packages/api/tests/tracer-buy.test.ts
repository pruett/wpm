import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { CreateMarketTx, DistributeTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14567;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-tracer-buy";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-tracer-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-${randomUUID()}.jsonl`);

// --- Dynamic imports (trading.ts + db/index.ts read env at module init) ---
const { trading } = await import("../src/routes/trading");
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
const userKeys = generateKeyPair();
const marketId = randomUUID();
const userId = randomUUID();

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let token: string;

describe("tracer-buy: POST /markets/:marketId/buy", () => {
  beforeAll(async () => {
    // 1. Bootstrap blockchain with genesis (10M WPM to treasury)
    state = new ChainState(poaKeys.publicKey);
    const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
    state.applyBlock(genesis);

    mempool = new Mempool(oracleKeys.publicKey);
    eventBus = new EventBus();

    // 2. Create a market (signed by oracle)
    const createMarketTx: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey,
      signature: "",
      marketId,
      sport: "NBA",
      homeTeam: "Lakers",
      awayTeam: "Celtics",
      outcomeA: "Home",
      outcomeB: "Away",
      eventStartTime: Date.now() + 3_600_000,
      seedAmount: 10000,
      externalEventId: randomUUID(),
    };
    createMarketTx.signature = sign(
      JSON.stringify({ ...createMarketTx, signature: undefined }),
      oracleKeys.privateKey,
    );
    mempool.add(createMarketTx, state);

    // 3. Distribute 100K WPM to test user (signed by PoA/treasury)
    const distributeTx: DistributeTx = {
      id: randomUUID(),
      type: "Distribute",
      timestamp: Date.now(),
      sender: poaKeys.publicKey,
      recipient: userKeys.publicKey,
      amount: 100_000,
      reason: "signup_airdrop",
      signature: "",
    };
    distributeTx.signature = sign(
      JSON.stringify({ ...distributeTx, signature: undefined }),
      poaKeys.privateKey,
    );
    mempool.add(distributeTx, state);

    // 4. Produce block to commit setup transactions
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // 5. Start node HTTP API
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

    // 6. Seed SQLite: user row with encrypted wallet private key
    const db = getDb();
    const encryptedKey = await encryptPrivateKey(
      userKeys.privateKey,
      process.env.WALLET_ENCRYPTION_KEY!,
    );
    db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      userId,
      "Test User",
      "test@example.com",
      userKeys.publicKey,
      encryptedKey,
      "user",
      Date.now(),
    );

    // 7. Mint JWT for test user
    token = await signJwt({
      sub: userId,
      role: "user" as const,
      walletAddress: userKeys.publicKey,
      email: "test@example.com",
    });

    // 8. Create Hono app with trading routes
    app = new Hono();
    app.route("/", trading);
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

  test("returns 202 with receipt on successful buy", async () => {
    const res = await app.request(`/markets/${marketId}/buy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.txId).toBeDefined();
    expect(typeof body.txId).toBe("string");
    expect(body.marketId).toBe(marketId);
    expect(body.outcome).toBe("A");
    expect(body.amount).toBe(100);
    expect(body.status).toBe("accepted");
  });

  test("node state updated after block production", async () => {
    // Produce block to commit the PlaceBet tx submitted in previous test
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // Verify balance via node HTTP API
    const balanceRes = await fetch(
      `http://127.0.0.1:${NODE_PORT}/internal/balance/${encodeURIComponent(userKeys.publicKey)}`,
    );
    const balanceData = (await balanceRes.json()) as { balance: number };
    expect(balanceData.balance).toBe(100_000 - 100);

    // Verify shares via node HTTP API
    const sharesRes = await fetch(
      `http://127.0.0.1:${NODE_PORT}/internal/shares/${encodeURIComponent(userKeys.publicKey)}`,
    );
    const sharesData = (await sharesRes.json()) as {
      positions: Record<string, Record<string, { shares: number; costBasis: number }>>;
    };
    expect(sharesData.positions[marketId]?.A?.shares).toBeGreaterThan(0);
    expect(sharesData.positions[marketId]?.A?.costBasis).toBe(100);
  });

  test("rejects request without auth token", async () => {
    const res = await app.request(`/markets/${marketId}/buy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects invalid outcome", async () => {
    const res = await app.request(`/markets/${marketId}/buy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome: "C", amount: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_OUTCOME");
  });

  test("rejects amount with 3+ decimal places", async () => {
    const res = await app.request(`/markets/${marketId}/buy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome: "A", amount: 10.123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects negative amount", async () => {
    const res = await app.request(`/markets/${marketId}/buy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome: "A", amount: -50 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects nonexistent market", async () => {
    const res = await app.request("/markets/nonexistent-market-id/buy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
  });
});
