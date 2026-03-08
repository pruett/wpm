import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import { calculateBuy, calculatePrices } from "@wpm/shared/amm";
import type { CreateMarketTx, DistributeTx, PlaceBetTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14731;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-trading-preview";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-trading-preview-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-trading-preview-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { trading } = await import("../src/routes/trading");
const { signJwt } = await import("../src/middleware/auth");
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
const marketId1 = randomUUID(); // open, with bets (shifted prices)
const marketId2 = randomUUID(); // open, no bets (equal prices)
const marketIdResolved = randomUUID(); // resolved market
const userId = randomUUID();

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let token: string;

beforeAll(async () => {
  // 1. Bootstrap blockchain with genesis
  state = new ChainState(poaKeys.publicKey);
  const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
  state.applyBlock(genesis);

  mempool = new Mempool(oracleKeys.publicKey);
  eventBus = new EventBus();

  // 2. Create open market with seed
  const createMarket1: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketId1,
    sport: "NBA",
    homeTeam: "Lakers",
    awayTeam: "Celtics",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: Date.now() + 3_600_000,
    seedAmount: 10000,
    externalEventId: randomUUID(),
  };
  createMarket1.signature = sign(
    JSON.stringify({ ...createMarket1, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createMarket1, state);

  // Create second open market (no bets, equal prices)
  const createMarket2: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now() + 1,
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketId2,
    sport: "NFL",
    homeTeam: "Chiefs",
    awayTeam: "Eagles",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: Date.now() + 7_200_000,
    seedAmount: 5000,
    externalEventId: randomUUID(),
  };
  createMarket2.signature = sign(
    JSON.stringify({ ...createMarket2, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createMarket2, state);

  // Create market that will be resolved
  const resolvedEventStart = Date.now() + 50;
  const createMarketResolved: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now() + 2,
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdResolved,
    sport: "MLB",
    homeTeam: "Yankees",
    awayTeam: "Red Sox",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: resolvedEventStart,
    seedAmount: 8000,
    externalEventId: randomUUID(),
  };
  createMarketResolved.signature = sign(
    JSON.stringify({ ...createMarketResolved, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createMarketResolved, state);

  // 3. Distribute WPM to user
  const dist: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 3,
    sender: poaKeys.publicKey,
    recipient: userKeys.publicKey,
    amount: 100_000,
    reason: "signup_airdrop",
    signature: "",
  };
  dist.signature = sign(JSON.stringify({ ...dist, signature: undefined }), poaKeys.privateKey);
  mempool.add(dist, state);

  // 4. Produce block to commit setup
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 5. Place a bet on market1 to shift prices
  const betTx: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 10,
    sender: userKeys.publicKey,
    signature: "",
    marketId: marketId1,
    outcome: "A",
    amount: 500,
  };
  betTx.signature = sign(JSON.stringify({ ...betTx, signature: undefined }), userKeys.privateKey);
  mempool.add(betTx, state);

  // 6. Produce block with bet
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 7. Resolve market
  const { ResolveMarketTx: _ } = await import("@wpm/shared");
  const resolveTx = {
    id: randomUUID(),
    type: "ResolveMarket" as const,
    timestamp: Math.max(Date.now() + 30, resolvedEventStart),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdResolved,
    winningOutcome: "A" as const,
    finalScore: "5-3",
  };
  resolveTx.signature = sign(
    JSON.stringify({ ...resolveTx, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(resolveTx, state);

  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 8. Start node HTTP API
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

  // 9. Seed SQLite with user
  const db = getDb();
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    userId,
    "Preview User",
    "previewuser@example.com",
    userKeys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now(),
  );

  // 10. Mint JWT
  token = await signJwt({
    sub: userId,
    role: "user" as const,
    walletAddress: userKeys.publicKey,
    email: "previewuser@example.com",
  });

  // 11. Create Hono app with trading routes
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

describe("POST /markets/:marketId/buy/preview", () => {
  test("returns preview for valid buy on equal-price market", async () => {
    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sharesReceived).toBeGreaterThan(0);
    expect(body.effectivePrice).toBeGreaterThan(0);
    expect(body.priceImpact).toBeGreaterThanOrEqual(0);
    expect(body.fee).toBe(1); // 1% of 100
    expect(body.newPriceA).toBeGreaterThan(0);
    expect(body.newPriceB).toBeGreaterThan(0);
    // New prices still sum to ~1.0
    expect(body.newPriceA + body.newPriceB).toBeCloseTo(1.0, 4);
  });

  test("preview matches AMM calculation exactly", async () => {
    // Fetch the current pool state for market2 (no bets, equal prices)
    const pool = state.pools.get(marketId2)!;
    const currentPrices = calculatePrices(pool);
    const buyResult = calculateBuy(pool, "A", 200);
    const newPrices = calculatePrices(buyResult.pool);

    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 200 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sharesReceived).toBe(buyResult.sharesToUser);
    expect(body.fee).toBe(2); // 1% of 200
    expect(body.newPriceA).toBe(Math.round(newPrices.priceA * 100) / 100);
    expect(body.newPriceB).toBe(Math.round(newPrices.priceB * 100) / 100);
  });

  test("preview on shifted-price market returns correct values", async () => {
    const res = await app.request(`/markets/${marketId1}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "B", amount: 500 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.sharesReceived).toBeGreaterThan(0);
    expect(body.effectivePrice).toBeGreaterThan(0);
    expect(body.fee).toBe(5); // 1% of 500
    // After buying B on a market where A was bought, prices shift
    expect(body.newPriceA + body.newPriceB).toBeCloseTo(1.0, 4);
  });

  test("preview is read-only — does not change pool state", async () => {
    // Get pool state before preview
    const poolBefore = { ...state.pools.get(marketId2)! };

    await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 1000 }),
    });

    // Pool state should be unchanged after preview
    const poolAfter = state.pools.get(marketId2)!;
    expect(poolAfter.sharesA).toBe(poolBefore.sharesA);
    expect(poolAfter.sharesB).toBe(poolBefore.sharesB);
    expect(poolAfter.k).toBe(poolBefore.k);
    expect(poolAfter.wpmLocked).toBe(poolBefore.wpmLocked);
  });

  test("rejects invalid outcome", async () => {
    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "C", amount: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_OUTCOME");
  });

  test("rejects amount with 3+ decimal places", async () => {
    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 100.123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects negative amount", async () => {
    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: -50 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects zero amount", async () => {
    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 0 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("returns 404 for nonexistent market", async () => {
    const res = await app.request(`/markets/${randomUUID()}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
  });

  test("rejects preview on resolved market", async () => {
    const res = await app.request(`/markets/${marketIdResolved}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_ALREADY_RESOLVED");
  });

  test("rejects request without auth", async () => {
    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("accepts amount with exactly 2 decimal places", async () => {
    const res = await app.request(`/markets/${marketId2}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "B", amount: 50.25 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sharesReceived).toBeGreaterThan(0);
    expect(body.fee).toBe(0.5); // 1% of 50.25 rounded to 2 decimals
  });
});
