import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { CreateMarketTx, PlaceBetTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14810;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-admin-markets";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
process.env.ADMIN_API_KEY = "test-admin-api-key-for-markets";
const DB_PATH = join(tmpdir(), `wpm-admin-mkt-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-admin-mkt-${randomUUID()}.jsonl`);

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
const userKeys = generateKeyPair();
const userId = randomUUID();

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

// Market IDs
const market1Id = randomUUID(); // open market, no trades — for cancel/resolve/seed tests
const market2Id = randomUUID(); // open market, with trades — for seed rejection test
const market3Id = randomUUID(); // resolved market — for cancel/resolve rejection tests

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

  // 3. Seed SQLite with a user
  const db = getDb();
  const encKey = await encryptPrivateKey(userKeys.privateKey, process.env.WALLET_ENCRYPTION_KEY!);
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    userId,
    "TestUser",
    `user-${randomUUID()}@example.com`,
    userKeys.publicKey,
    encKey,
    "user",
    Date.now(),
  );

  // 4. Distribute funds to user for trading
  const distRes = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/distribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: userKeys.publicKey,
      amount: 100000,
      reason: "signup_airdrop",
    }),
  });
  expect(distRes.status).toBe(202);

  // 5. Create market1 (open, no trades)
  const eventStartTime1 = Date.now() + 3600_000; // 1 hour from now
  const createMarket1: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market1Id,
    sport: "NFL",
    homeTeam: "Chiefs",
    awayTeam: "Eagles",
    outcomeA: "Chiefs Win",
    outcomeB: "Eagles Win",
    eventStartTime: eventStartTime1,
    seedAmount: 10000,
    externalEventId: `event-${randomUUID()}`,
  };
  createMarket1.signature = sign(
    JSON.stringify({ ...createMarket1, signature: undefined }),
    oracleKeys.privateKey,
  );
  const cm1Res = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createMarket1),
  });
  expect(cm1Res.status).toBe(202);

  // 6. Create market2 (open, will have trades, near-future eventStartTime so we can resolve after)
  const eventStartTime2 = Date.now() + 2000;
  const createMarket2: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market2Id,
    sport: "NBA",
    homeTeam: "Lakers",
    awayTeam: "Celtics",
    outcomeA: "Lakers Win",
    outcomeB: "Celtics Win",
    eventStartTime: eventStartTime2,
    seedAmount: 10000,
    externalEventId: `event-${randomUUID()}`,
  };
  createMarket2.signature = sign(
    JSON.stringify({ ...createMarket2, signature: undefined }),
    oracleKeys.privateKey,
  );
  const cm2Res = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createMarket2),
  });
  expect(cm2Res.status).toBe(202);

  // 7. Create market3 (will be resolved)
  const eventStartTime3 = Date.now() + 100; // very near future
  const createMarket3: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market3Id,
    sport: "MLB",
    homeTeam: "Yankees",
    awayTeam: "Red Sox",
    outcomeA: "Yankees Win",
    outcomeB: "Red Sox Win",
    eventStartTime: eventStartTime3,
    seedAmount: 5000,
    externalEventId: `event-${randomUUID()}`,
  };
  createMarket3.signature = sign(
    JSON.stringify({ ...createMarket3, signature: undefined }),
    oracleKeys.privateKey,
  );
  const cm3Res = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createMarket3),
  });
  expect(cm3Res.status).toBe(202);

  // Produce block to commit all setup transactions
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 8. Place a bet on market2 so it has trades
  const betTx: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now(),
    sender: userKeys.publicKey,
    signature: "",
    marketId: market2Id,
    outcome: "A",
    amount: 500,
  };
  betTx.signature = sign(JSON.stringify({ ...betTx, signature: undefined }), userKeys.privateKey);
  const betRes = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(betTx),
  });
  expect(betRes.status).toBe(202);

  // 9. Resolve market3
  // Wait for eventStartTime to pass
  await new Promise((resolve) => setTimeout(resolve, 150));
  const resolveTx = {
    id: randomUUID(),
    type: "ResolveMarket",
    timestamp: Math.max(Date.now(), eventStartTime3),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market3Id,
    winningOutcome: "A",
    finalScore: "5-3",
  };
  resolveTx.signature = sign(
    JSON.stringify({ ...resolveTx, signature: undefined }),
    oracleKeys.privateKey,
  );
  const resolveRes = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resolveTx),
  });
  expect(resolveRes.status).toBe(202);

  // Produce block to commit bet and resolution
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 10. Mint tokens
  adminToken = await signJwt({
    sub: "admin",
    role: "admin" as const,
  });

  userToken = await signJwt({
    sub: userId,
    role: "user" as const,
    walletAddress: userKeys.publicKey,
    email: "user@example.com",
  });

  // 11. Create Hono app with admin routes
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

// --- POST /admin/markets/:marketId/cancel ---

describe("POST /admin/markets/:marketId/cancel", () => {
  test("cancel succeeds with 202 and correct response shape", async () => {
    const res = await app.request(`/admin/markets/${market1Id}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "Event postponed" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.txId).toBeDefined();
    expect(body.marketId).toBe(market1Id);
    expect(body.status).toBe("accepted");
  });

  test("market status is cancelled after block production", () => {
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    const market = state.markets.get(market1Id);
    expect(market).toBeDefined();
    expect(market!.status).toBe("cancelled");
    expect(market!.resolvedAt).toBeDefined();
  });

  test("rejects cancel on already resolved market → MARKET_ALREADY_RESOLVED (400)", async () => {
    const res = await app.request(`/admin/markets/${market3Id}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "Too late" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_ALREADY_RESOLVED");
  });

  test("rejects cancel on already cancelled market → MARKET_CLOSED (400)", async () => {
    // market1 was cancelled in earlier test
    const res = await app.request(`/admin/markets/${market1Id}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "Double cancel" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_CLOSED");
  });

  test("rejects nonexistent market → MARKET_NOT_FOUND (404)", async () => {
    const res = await app.request(`/admin/markets/${randomUUID()}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "No such market" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
  });

  test("rejects missing reason → 400", async () => {
    const res = await app.request(`/admin/markets/${market2Id}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request(`/admin/markets/${market2Id}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "Unauthorized" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request(`/admin/markets/${market2Id}/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "No auth" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// --- POST /admin/markets/:marketId/resolve ---

describe("POST /admin/markets/:marketId/resolve", () => {
  test("resolve succeeds with 202 and correct response shape", async () => {
    // Wait for market2's eventStartTime to pass so resolve is valid
    const market2 = state.markets.get(market2Id)!;
    const waitMs = market2.eventStartTime - Date.now() + 50;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const res = await app.request(`/admin/markets/${market2Id}/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ winningOutcome: "A", finalScore: "Lakers 110, Celtics 98" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.txId).toBeDefined();
    expect(body.marketId).toBe(market2Id);
    expect(body.winningOutcome).toBe("A");
    expect(body.status).toBe("accepted");
  });

  test("market is resolved with correct outcome after block production", () => {
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    const market = state.markets.get(market2Id);
    expect(market).toBeDefined();
    expect(market!.status).toBe("resolved");
    expect(market!.winningOutcome).toBe("A");
    expect(market!.finalScore).toBe("Lakers 110, Celtics 98");
    expect(market!.resolvedAt).toBeDefined();
  });

  test("rejects resolve on already resolved market → MARKET_ALREADY_RESOLVED (400)", async () => {
    const res = await app.request(`/admin/markets/${market3Id}/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ winningOutcome: "B", finalScore: "2-1" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_ALREADY_RESOLVED");
  });

  test("rejects invalid winningOutcome → INVALID_OUTCOME (400)", async () => {
    const res = await app.request(`/admin/markets/${market2Id}/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ winningOutcome: "C", finalScore: "1-0" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_OUTCOME");
  });

  test("rejects missing finalScore → 400", async () => {
    const res = await app.request(`/admin/markets/${market2Id}/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ winningOutcome: "A" }),
    });

    expect(res.status).toBe(400);
  });

  test("rejects nonexistent market → MARKET_NOT_FOUND (404)", async () => {
    const res = await app.request(`/admin/markets/${randomUUID()}/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ winningOutcome: "A", finalScore: "1-0" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request(`/admin/markets/${market2Id}/resolve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ winningOutcome: "A", finalScore: "1-0" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request(`/admin/markets/${market2Id}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ winningOutcome: "A", finalScore: "1-0" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

// --- POST /admin/markets/:marketId/seed ---

describe("POST /admin/markets/:marketId/seed", () => {
  // Create a fresh market for seed tests (market1 was cancelled, market2 was resolved above)
  const seedMarketId = randomUUID();
  const seedMarketWithTradesId = randomUUID();

  beforeAll(async () => {
    // Create a market with no trades for seed testing
    const eventStartTime = Date.now() + 3600_000;
    const createMarket: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey,
      signature: "",
      marketId: seedMarketId,
      sport: "NHL",
      homeTeam: "Bruins",
      awayTeam: "Rangers",
      outcomeA: "Bruins Win",
      outcomeB: "Rangers Win",
      eventStartTime,
      seedAmount: 8000,
      externalEventId: `event-seed-${randomUUID()}`,
    };
    createMarket.signature = sign(
      JSON.stringify({ ...createMarket, signature: undefined }),
      oracleKeys.privateKey,
    );
    const cmRes = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createMarket),
    });
    expect(cmRes.status).toBe(202);

    // Create a market that will have trades
    const createMarketWithTrades: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey,
      signature: "",
      marketId: seedMarketWithTradesId,
      sport: "MLS",
      homeTeam: "LAFC",
      awayTeam: "Galaxy",
      outcomeA: "LAFC Win",
      outcomeB: "Galaxy Win",
      eventStartTime,
      seedAmount: 5000,
      externalEventId: `event-seed-trades-${randomUUID()}`,
    };
    createMarketWithTrades.signature = sign(
      JSON.stringify({ ...createMarketWithTrades, signature: undefined }),
      oracleKeys.privateKey,
    );
    const cmtRes = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createMarketWithTrades),
    });
    expect(cmtRes.status).toBe(202);

    // Produce block to commit both markets
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // Place a bet on the trades market
    const betTx: PlaceBetTx = {
      id: randomUUID(),
      type: "PlaceBet",
      timestamp: Date.now(),
      sender: userKeys.publicKey,
      signature: "",
      marketId: seedMarketWithTradesId,
      outcome: "B",
      amount: 200,
    };
    betTx.signature = sign(JSON.stringify({ ...betTx, signature: undefined }), userKeys.privateKey);
    const betRes = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(betTx),
    });
    expect(betRes.status).toBe(202);

    // Produce block to commit the bet
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );
  });

  test("seed succeeds with 202 and returns both txIds + new marketId", async () => {
    const res = await app.request(`/admin/markets/${seedMarketId}/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seedAmount: 15000 }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.cancelTxId).toBeDefined();
    expect(body.createTxId).toBeDefined();
    expect(body.oldMarketId).toBe(seedMarketId);
    expect(body.newMarketId).toBeDefined();
    expect(body.newMarketId).not.toBe(seedMarketId);
    expect(body.seedAmount).toBe(15000);
    expect(body.status).toBe("accepted");
  });

  test("old market is cancelled and new market is created after block production", async () => {
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // Old market should be cancelled
    const oldMarket = state.markets.get(seedMarketId);
    expect(oldMarket).toBeDefined();
    expect(oldMarket!.status).toBe("cancelled");

    // Find the new market (the one with seedAmount 15000 and same sport)
    let newMarket;
    for (const [, m] of state.markets) {
      if (m.seedAmount === 15000 && m.sport === "NHL") {
        newMarket = m;
      }
    }
    expect(newMarket).toBeDefined();
    expect(newMarket!.status).toBe("open");
    expect(newMarket!.homeTeam).toBe("Bruins");
    expect(newMarket!.awayTeam).toBe("Rangers");
    expect(newMarket!.outcomeA).toBe("Bruins Win");
    expect(newMarket!.outcomeB).toBe("Rangers Win");
  });

  test("rejects seed when market has trades → MARKET_HAS_TRADES (400)", async () => {
    const res = await app.request(`/admin/markets/${seedMarketWithTradesId}/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seedAmount: 20000 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_HAS_TRADES");
  });

  test("rejects invalid seedAmount (3+ decimal places) → INVALID_AMOUNT (400)", async () => {
    const res = await app.request(`/admin/markets/${seedMarketWithTradesId}/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seedAmount: 100.123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects zero seedAmount → INVALID_AMOUNT (400)", async () => {
    const res = await app.request(`/admin/markets/${seedMarketWithTradesId}/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seedAmount: 0 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects nonexistent market → MARKET_NOT_FOUND (404)", async () => {
    const res = await app.request(`/admin/markets/${randomUUID()}/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seedAmount: 5000 }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_NOT_FOUND");
  });

  test("rejects user JWT → FORBIDDEN (403)", async () => {
    const res = await app.request(`/admin/markets/${seedMarketId}/seed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${userToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seedAmount: 5000 }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("rejects missing auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request(`/admin/markets/${seedMarketId}/seed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ seedAmount: 5000 }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
