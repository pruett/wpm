import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { PlaceBetTx, DistributeTx, CreateMarketTx } from "@wpm/shared";

// Second user for position testing
const user2Keys = generateKeyPair();
const user2Id = randomUUID();

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14623;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-markets";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-markets-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-markets-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { markets } = await import("../src/routes/markets");
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
const marketId1 = randomUUID();
const marketId2 = randomUUID();
const userId = randomUUID();

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let token: string;
let token2: string;

beforeAll(async () => {
  // 1. Bootstrap blockchain with genesis
  state = new ChainState(poaKeys.publicKey);
  const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
  state.applyBlock(genesis);

  mempool = new Mempool(oracleKeys.publicKey);
  eventBus = new EventBus();

  // 2. Create two markets (signed by oracle)
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

  // 3. Distribute WPM to user
  const dist: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 2,
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

  // 5. Place a bet on market1 to create volume
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

  // Place another bet on market1
  const betTx2: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 20,
    sender: userKeys.publicKey,
    signature: "",
    marketId: marketId1,
    outcome: "B",
    amount: 300,
  };
  betTx2.signature = sign(JSON.stringify({ ...betTx2, signature: undefined }), userKeys.privateKey);
  mempool.add(betTx2, state);

  // 6. Produce second block
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 7. Start node HTTP API
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

  // 8. Seed SQLite with user
  const db = getDb();
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    userId,
    "Market User",
    "marketuser@example.com",
    userKeys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now(),
  );

  // Seed user2 in SQLite (no bets, no positions)
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user2Id,
    "User Two",
    "user2-markets@example.com",
    user2Keys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now(),
  );

  // 9. Mint JWTs
  token = await signJwt({
    sub: userId,
    role: "user" as const,
    walletAddress: userKeys.publicKey,
    email: "marketuser@example.com",
  });

  token2 = await signJwt({
    sub: user2Id,
    role: "user" as const,
    walletAddress: user2Keys.publicKey,
    email: "user2-markets@example.com",
  });

  // 10. Create Hono app with markets routes
  app = new Hono();
  app.route("/", markets);
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

describe("GET /markets", () => {
  test("returns only open markets", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    expect(body.markets.length).toBe(2);

    const ids = body.markets.map((m: any) => m.marketId);
    expect(ids).toContain(marketId1);
    expect(ids).toContain(marketId2);
  });

  test("markets include prices that sum to ~1.00", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();

    for (const market of body.markets) {
      expect(market.prices).toBeDefined();
      expect(market.prices.priceA).toBeGreaterThan(0);
      expect(market.prices.priceB).toBeGreaterThan(0);
      // Prices should sum to approximately 1.0
      const sum = market.prices.priceA + market.prices.priceB;
      expect(sum).toBeCloseTo(1.0, 4);
    }
  });

  test("markets include multipliers as 1/price", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();

    for (const market of body.markets) {
      expect(market.multipliers).toBeDefined();
      expect(market.multipliers.multiplierA).toBeGreaterThan(0);
      expect(market.multipliers.multiplierB).toBeGreaterThan(0);

      // Multiplier should be 1/price (rounded to 2 decimals)
      const expectedMultA = Math.round((1 / market.prices.priceA) * 100) / 100;
      const expectedMultB = Math.round((1 / market.prices.priceB) * 100) / 100;
      expect(market.multipliers.multiplierA).toBe(expectedMultA);
      expect(market.multipliers.multiplierB).toBe(expectedMultB);
    }
  });

  test("market1 has totalVolume from bets", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const market1 = body.markets.find((m: any) => m.marketId === marketId1);
    // 500 + 300 = 800 total volume from PlaceBet txs
    expect(market1.totalVolume).toBe(800);
  });

  test("market2 has zero volume", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const market2 = body.markets.find((m: any) => m.marketId === marketId2);
    expect(market2.totalVolume).toBe(0);
  });

  test("market2 with no bets has equal prices (0.5/0.5)", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const market2 = body.markets.find((m: any) => m.marketId === marketId2);
    expect(market2.prices.priceA).toBe(0.5);
    expect(market2.prices.priceB).toBe(0.5);
    expect(market2.multipliers.multiplierA).toBe(2);
    expect(market2.multipliers.multiplierB).toBe(2);
  });

  test("market1 prices shifted by bets", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const market1 = body.markets.find((m: any) => m.marketId === marketId1);
    // After buying A and B with different amounts, prices should be shifted
    // Buying more A than B means priceA should be higher than 0.5
    expect(market1.prices.priceA).not.toBe(0.5);
  });

  test("enriched markets include original fields", async () => {
    const res = await app.request("/markets", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const market1 = body.markets.find((m: any) => m.marketId === marketId1);

    expect(market1.sport).toBe("NBA");
    expect(market1.homeTeam).toBe("Lakers");
    expect(market1.awayTeam).toBe("Celtics");
    expect(market1.outcomeA).toBe("Home");
    expect(market1.outcomeB).toBe("Away");
    expect(market1.status).toBe("open");
    expect(market1.seedAmount).toBe(10000);
    expect(market1.eventStartTime).toBeGreaterThan(0);
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/markets");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /markets/:marketId", () => {
  test("returns market with pool and prices", async () => {
    const res = await app.request(`/markets/${marketId1}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.market).toBeDefined();
    expect(body.market.marketId).toBe(marketId1);
    expect(body.market.sport).toBe("NBA");
    expect(body.market.homeTeam).toBe("Lakers");
    expect(body.market.awayTeam).toBe("Celtics");
    expect(body.market.status).toBe("open");

    expect(body.pool).toBeDefined();
    expect(body.pool.marketId).toBe(marketId1);
    expect(body.pool.sharesA).toBeGreaterThan(0);
    expect(body.pool.sharesB).toBeGreaterThan(0);

    expect(body.prices).toBeDefined();
    const sum = body.prices.priceA + body.prices.priceB;
    expect(sum).toBeCloseTo(1.0, 4);
  });

  test("includes user position when user has shares", async () => {
    const res = await app.request(`/markets/${marketId1}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();

    // User placed bets on market1 (outcome A: 500 WPM, outcome B: 300 WPM)
    expect(body.userPosition).not.toBeNull();
    expect(body.userPosition.outcomeA).not.toBeNull();
    expect(body.userPosition.outcomeA.shares).toBeGreaterThan(0);
    expect(body.userPosition.outcomeA.costBasis).toBeGreaterThan(0);
    expect(body.userPosition.outcomeA.estimatedValue).toBeGreaterThan(0);

    expect(body.userPosition.outcomeB).not.toBeNull();
    expect(body.userPosition.outcomeB.shares).toBeGreaterThan(0);
    expect(body.userPosition.outcomeB.costBasis).toBeGreaterThan(0);
    expect(body.userPosition.outcomeB.estimatedValue).toBeGreaterThan(0);
  });

  test("userPosition is null when user has no shares", async () => {
    // user2 has no bets on market1
    const res = await app.request(`/markets/${marketId1}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });

    const body = await res.json();
    expect(body.userPosition).toBeNull();
  });

  test("userPosition is null for market with no positions", async () => {
    // user1 has no bets on market2
    const res = await app.request(`/markets/${marketId2}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    expect(body.userPosition).toBeNull();
  });

  test("returns 404 for nonexistent market", async () => {
    const res = await app.request(`/markets/${randomUUID()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
  });

  test("rejects request without auth", async () => {
    const res = await app.request(`/markets/${marketId1}`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /markets/:marketId/trades", () => {
  test("returns trades for market with user display names", async () => {
    const res = await app.request(`/markets/${marketId1}/trades`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades).toBeArray();
    // market1 has 2 PlaceBet trades (500 on A, 300 on B)
    expect(body.trades.length).toBe(2);
    expect(body.total).toBe(2);

    // All trades should have userName from SQLite join
    for (const trade of body.trades) {
      expect(trade.userName).toBe("Market User");
      expect(trade.marketId).toBe(marketId1);
      expect(["PlaceBet", "SellShares"]).toContain(trade.type);
    }
  });

  test("trades sorted by timestamp descending", async () => {
    const res = await app.request(`/markets/${marketId1}/trades`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    for (let i = 1; i < body.trades.length; i++) {
      expect(body.trades[i - 1].timestamp).toBeGreaterThanOrEqual(body.trades[i].timestamp);
    }
  });

  test("returns empty trades for market with no bets", async () => {
    const res = await app.request(`/markets/${marketId2}/trades`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades).toBeArray();
    expect(body.trades.length).toBe(0);
    expect(body.total).toBe(0);
  });

  test("pagination with limit and offset", async () => {
    const res = await app.request(`/markets/${marketId1}/trades?limit=1&offset=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades.length).toBe(1);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);

    // Page 2
    const res2 = await app.request(`/markets/${marketId1}/trades?limit=1&offset=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body2 = await res2.json();
    expect(body2.trades.length).toBe(1);
    expect(body2.total).toBe(2);
    expect(body2.offset).toBe(1);

    // Different trades on each page
    expect(body.trades[0].id).not.toBe(body2.trades[0].id);
  });

  test("limit clamped to 100", async () => {
    const res = await app.request(`/markets/${marketId1}/trades?limit=500`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    expect(body.limit).toBe(100);
  });

  test("returns 404 for nonexistent market", async () => {
    const res = await app.request(`/markets/${randomUUID()}/trades`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
  });

  test("rejects request without auth", async () => {
    const res = await app.request(`/markets/${marketId1}/trades`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
