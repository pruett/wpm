import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type {
  PlaceBetTx,
  DistributeTx,
  CreateMarketTx,
  ResolveMarketTx,
  CancelMarketTx,
} from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14710;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-user";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-user-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-user-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { user: userRoutes } = await import("../src/routes/user");
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
const user2Keys = generateKeyPair();
const marketIdOpen = randomUUID(); // open market with user bets
const marketIdOpen2 = randomUUID(); // open market without user bets
const marketIdResolved = randomUUID(); // resolved market with user bets (winner)
const marketIdCancelled = randomUUID(); // cancelled market with user bets (refund)
const userId = randomUUID();
const user2Id = randomUUID();
const userCreatedAt = Date.now() - 86400_000; // created 1 day ago

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let token: string;
let token2: string;
let tokenNoWallet: string;

beforeAll(async () => {
  // 1. Bootstrap blockchain with genesis
  state = new ChainState(poaKeys.publicKey);
  const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
  state.applyBlock(genesis);

  mempool = new Mempool(oracleKeys.publicKey);
  eventBus = new EventBus();

  // 2. Create markets (signed by oracle)
  // Open market 1 — user will bet on this
  const createOpenMarket: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdOpen,
    sport: "NBA",
    homeTeam: "Lakers",
    awayTeam: "Celtics",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: Date.now() + 3_600_000,
    seedAmount: 10000,
    externalEventId: randomUUID(),
  };
  createOpenMarket.signature = sign(
    JSON.stringify({ ...createOpenMarket, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createOpenMarket, state);

  // Open market 2 — user will NOT bet on this
  const createOpenMarket2: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now() + 1,
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdOpen2,
    sport: "NFL",
    homeTeam: "Chiefs",
    awayTeam: "Eagles",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: Date.now() + 7_200_000,
    seedAmount: 5000,
    externalEventId: randomUUID(),
  };
  createOpenMarket2.signature = sign(
    JSON.stringify({ ...createOpenMarket2, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createOpenMarket2, state);

  // Resolved market — user will bet on winning outcome
  const resolvedEventStart = Date.now() + 50;
  const createResolvedMarket: CreateMarketTx = {
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
  createResolvedMarket.signature = sign(
    JSON.stringify({ ...createResolvedMarket, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createResolvedMarket, state);

  // Cancelled market — user will bet on this
  const createCancelledMarket: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now() + 3,
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdCancelled,
    sport: "NHL",
    homeTeam: "Rangers",
    awayTeam: "Bruins",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: Date.now() + 3_600_000,
    seedAmount: 6000,
    externalEventId: randomUUID(),
  };
  createCancelledMarket.signature = sign(
    JSON.stringify({ ...createCancelledMarket, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createCancelledMarket, state);

  // 3. Distribute WPM to user
  const dist: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 4,
    sender: poaKeys.publicKey,
    recipient: userKeys.publicKey,
    amount: 100_000,
    reason: "signup_airdrop",
    signature: "",
  };
  dist.signature = sign(JSON.stringify({ ...dist, signature: undefined }), poaKeys.privateKey);
  mempool.add(dist, state);

  // 4. Produce block 1 — genesis setup
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 5. User places bets on open market, resolved market, and cancelled market
  const betOpen: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 10,
    sender: userKeys.publicKey,
    signature: "",
    marketId: marketIdOpen,
    outcome: "A",
    amount: 500,
  };
  betOpen.signature = sign(
    JSON.stringify({ ...betOpen, signature: undefined }),
    userKeys.privateKey,
  );
  mempool.add(betOpen, state);

  const betResolved: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 11,
    sender: userKeys.publicKey,
    signature: "",
    marketId: marketIdResolved,
    outcome: "A",
    amount: 1000,
  };
  betResolved.signature = sign(
    JSON.stringify({ ...betResolved, signature: undefined }),
    userKeys.privateKey,
  );
  mempool.add(betResolved, state);

  const betCancelled: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 12,
    sender: userKeys.publicKey,
    signature: "",
    marketId: marketIdCancelled,
    outcome: "B",
    amount: 200,
  };
  betCancelled.signature = sign(
    JSON.stringify({ ...betCancelled, signature: undefined }),
    userKeys.privateKey,
  );
  mempool.add(betCancelled, state);

  // 6. Produce block 2 — bets committed
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 7. Resolve and cancel markets
  const resolveTx: ResolveMarketTx = {
    id: randomUUID(),
    type: "ResolveMarket",
    timestamp: Math.max(Date.now() + 30, resolvedEventStart),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdResolved,
    winningOutcome: "A",
    finalScore: "5-3",
  };
  resolveTx.signature = sign(
    JSON.stringify({ ...resolveTx, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(resolveTx, state);

  const cancelTx: CancelMarketTx = {
    id: randomUUID(),
    type: "CancelMarket",
    timestamp: Date.now() + 31,
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdCancelled,
    reason: "Event postponed",
  };
  cancelTx.signature = sign(
    JSON.stringify({ ...cancelTx, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(cancelTx, state);

  // 8. Produce block 3 — resolve + cancel + settlement payouts
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 9. Start node HTTP API
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

  // 10. Seed SQLite with users
  const db = getDb();
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    userId,
    "Test User",
    "testuser@example.com",
    userKeys.publicKey,
    Buffer.from("placeholder"),
    "user",
    userCreatedAt,
  );

  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user2Id,
    "User Two",
    "user2-profile@example.com",
    user2Keys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now(),
  );

  // 11. Mint JWTs
  token = await signJwt({
    sub: userId,
    role: "user" as const,
    walletAddress: userKeys.publicKey,
    email: "testuser@example.com",
  });

  token2 = await signJwt({
    sub: user2Id,
    role: "user" as const,
    walletAddress: user2Keys.publicKey,
    email: "user2-profile@example.com",
  });

  tokenNoWallet = await signJwt({
    sub: randomUUID(),
    role: "user" as const,
  });

  // 12. Create Hono app with user routes
  app = new Hono();
  app.route("/", userRoutes);
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

describe("GET /user/profile", () => {
  test("returns correct profile fields", async () => {
    const res = await app.request("/user/profile", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(userId);
    expect(body.name).toBe("Test User");
    expect(body.email).toBe("testuser@example.com");
    expect(body.walletAddress).toBe(userKeys.publicKey);
    expect(body.createdAt).toBe(userCreatedAt);
  });

  test("returns profile for user2", async () => {
    const res = await app.request("/user/profile", {
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe(user2Id);
    expect(body.name).toBe("User Two");
    expect(body.email).toBe("user2-profile@example.com");
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/user/profile");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("returns 401 for nonexistent user", async () => {
    const fakeToken = await signJwt({
      sub: randomUUID(),
      role: "user" as const,
      walletAddress: "fake-wallet",
    });
    const res = await app.request("/user/profile", {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /user/positions", () => {
  test("returns positions with current valuations for open markets", async () => {
    const res = await app.request("/user/positions", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // User bet on open market only (resolved/cancelled positions are deleted from state)
    expect(body.positions.length).toBe(1);

    const pos = body.positions[0];
    expect(pos.marketId).toBe(marketIdOpen);
    expect(pos.outcome).toBe("A");
    expect(pos.shares).toBeGreaterThan(0);
    expect(pos.costBasis).toBe(500);
    expect(pos.currentPrice).toBeGreaterThan(0);
    expect(pos.currentPrice).toBeLessThanOrEqual(1);
    expect(pos.estimatedValue).toBeGreaterThan(0);

    // Market info included
    expect(pos.market.sport).toBe("NBA");
    expect(pos.market.homeTeam).toBe("Lakers");
    expect(pos.market.awayTeam).toBe("Celtics");
    expect(pos.market.outcomeA).toBe("Home");
    expect(pos.market.outcomeB).toBe("Away");
    expect(pos.market.eventStartTime).toBeGreaterThan(0);
  });

  test("returns empty positions for user with no bets", async () => {
    const res = await app.request("/user/positions", {
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.positions).toEqual([]);
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/user/positions");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects token without wallet address", async () => {
    const res = await app.request("/user/positions", {
      headers: { Authorization: `Bearer ${tokenNoWallet}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Token missing wallet address");
  });
});

describe("GET /user/history", () => {
  test("returns history for resolved and cancelled markets", async () => {
    const res = await app.request("/user/history", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // User bet on resolved and cancelled markets
    expect(body.history.length).toBe(2);

    const marketIds = body.history.map((h: any) => h.marketId);
    expect(marketIds).toContain(marketIdResolved);
    expect(marketIds).toContain(marketIdCancelled);
  });

  test("resolved market has correct payout and profit", async () => {
    const res = await app.request("/user/history", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const resolved = body.history.find((h: any) => h.marketId === marketIdResolved);

    expect(resolved).toBeDefined();
    expect(resolved.market.status).toBe("resolved");
    expect(resolved.market.winningOutcome).toBe("A");
    expect(resolved.market.finalScore).toBe("5-3");
    expect(resolved.market.resolvedAt).toBeGreaterThan(0);
    expect(resolved.market.sport).toBe("MLB");

    // User bet 1000 on outcome A (the winner)
    expect(resolved.costBasis).toBe(1000);
    // Payout = shares * 1.0 WPM (winner gets full share value)
    expect(resolved.payout).toBeGreaterThan(0);
    // Profit = payout - costBasis
    expect(resolved.profit).toBe(Math.round((resolved.payout - resolved.costBasis) * 100) / 100);
  });

  test("cancelled market has refund as payout", async () => {
    const res = await app.request("/user/history", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const cancelled = body.history.find((h: any) => h.marketId === marketIdCancelled);

    expect(cancelled).toBeDefined();
    expect(cancelled.market.status).toBe("cancelled");
    expect(cancelled.market.winningOutcome).toBeUndefined();

    // User bet 200 on cancelled market, refund = costBasis
    expect(cancelled.costBasis).toBe(200);
    expect(cancelled.payout).toBe(200); // full refund
    expect(cancelled.profit).toBe(0); // refund = costBasis, so profit = 0
  });

  test("returns empty history for user with no bets", async () => {
    const res = await app.request("/user/history", {
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toEqual([]);
  });

  test("does not include open markets in history", async () => {
    const res = await app.request("/user/history", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const body = await res.json();
    const marketIds = body.history.map((h: any) => h.marketId);
    expect(marketIds).not.toContain(marketIdOpen);
    expect(marketIds).not.toContain(marketIdOpen2);
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/user/history");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects token without wallet address", async () => {
    const res = await app.request("/user/history", {
      headers: { Authorization: `Bearer ${tokenNoWallet}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
