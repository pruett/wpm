import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { PlaceBetTx, DistributeTx, CreateMarketTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14720;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-leaderboard";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-leaderboard-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-leaderboard-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { leaderboard: leaderboardRoutes } = await import("../src/routes/leaderboard");
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
const user1Keys = generateKeyPair();
const user2Keys = generateKeyPair();
const user3Keys = generateKeyPair();
const marketId = randomUUID();
const user1Id = randomUUID();
const user2Id = randomUUID();
const user3Id = randomUUID();

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let token1: string;
let token2: string;
let token3: string;

beforeAll(async () => {
  // 1. Bootstrap blockchain with genesis
  state = new ChainState(poaKeys.publicKey);
  const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
  state.applyBlock(genesis);

  mempool = new Mempool(oracleKeys.publicKey);
  eventBus = new EventBus();

  // 2. Create a market
  const createMarket: CreateMarketTx = {
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
  createMarket.signature = sign(
    JSON.stringify({ ...createMarket, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createMarket, state);

  // 3. Distribute different amounts to users
  // User1: 100,000 WPM (richest)
  const dist1: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 1,
    sender: poaKeys.publicKey,
    recipient: user1Keys.publicKey,
    amount: 100_000,
    reason: "signup_airdrop",
    signature: "",
  };
  dist1.signature = sign(JSON.stringify({ ...dist1, signature: undefined }), poaKeys.privateKey);
  mempool.add(dist1, state);

  // User2: 50,000 WPM (middle)
  const dist2: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 2,
    sender: poaKeys.publicKey,
    recipient: user2Keys.publicKey,
    amount: 50_000,
    reason: "signup_airdrop",
    signature: "",
  };
  dist2.signature = sign(JSON.stringify({ ...dist2, signature: undefined }), poaKeys.privateKey);
  mempool.add(dist2, state);

  // User3: 25,000 WPM (lowest)
  const dist3: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 3,
    sender: poaKeys.publicKey,
    recipient: user3Keys.publicKey,
    amount: 25_000,
    reason: "signup_airdrop",
    signature: "",
  };
  dist3.signature = sign(JSON.stringify({ ...dist3, signature: undefined }), poaKeys.privateKey);
  mempool.add(dist3, state);

  // 4. Produce block 1 — distribute + create market
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 5. User1 places a bet (spends 500 WPM, gets shares worth something)
  const bet1: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 10,
    sender: user1Keys.publicKey,
    signature: "",
    marketId,
    outcome: "A",
    amount: 500,
  };
  bet1.signature = sign(JSON.stringify({ ...bet1, signature: undefined }), user1Keys.privateKey);
  mempool.add(bet1, state);

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

  // 8. Seed SQLite with users
  const db = getDb();
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user1Id,
    "Alice",
    "alice@example.com",
    user1Keys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now() - 86400_000,
  );

  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user2Id,
    "Bob",
    "bob@example.com",
    user2Keys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now() - 43200_000,
  );

  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user3Id,
    "Charlie",
    "charlie@example.com",
    user3Keys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now(),
  );

  // 9. Mint JWTs
  token1 = await signJwt({
    sub: user1Id,
    role: "user" as const,
    walletAddress: user1Keys.publicKey,
    email: "alice@example.com",
  });

  token2 = await signJwt({
    sub: user2Id,
    role: "user" as const,
    walletAddress: user2Keys.publicKey,
    email: "bob@example.com",
  });

  token3 = await signJwt({
    sub: user3Id,
    role: "user" as const,
    walletAddress: user3Keys.publicKey,
    email: "charlie@example.com",
  });

  // 10. Create Hono app with leaderboard routes
  app = new Hono();
  app.route("/", leaderboardRoutes);
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

describe("GET /leaderboard/alltime", () => {
  test("returns rankings for all users sorted by totalWpm descending", async () => {
    const res = await app.request("/leaderboard/alltime", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rankings).toBeArray();
    expect(body.rankings.length).toBe(3);

    // User1 has 100K initial (minus 500 bet, plus position value) — highest
    // User2 has 50K — middle
    // User3 has 25K — lowest
    expect(body.rankings[0].name).toBe("Alice");
    expect(body.rankings[1].name).toBe("Bob");
    expect(body.rankings[2].name).toBe("Charlie");
  });

  test("assigns 1-indexed ranks", async () => {
    const res = await app.request("/leaderboard/alltime", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();

    expect(body.rankings[0].rank).toBe(1);
    expect(body.rankings[1].rank).toBe(2);
    expect(body.rankings[2].rank).toBe(3);
  });

  test("includes correct fields in each ranking entry", async () => {
    const res = await app.request("/leaderboard/alltime", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();
    const entry = body.rankings[0];

    expect(entry.rank).toBeNumber();
    expect(entry.userId).toBe(user1Id);
    expect(entry.name).toBe("Alice");
    expect(entry.walletAddress).toBe(user1Keys.publicKey);
    expect(entry.balance).toBeNumber();
    expect(entry.positionValue).toBeNumber();
    expect(entry.totalWpm).toBeNumber();
  });

  test("user1 totalWpm includes balance and position value", async () => {
    const res = await app.request("/leaderboard/alltime", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();
    const alice = body.rankings.find((r: any) => r.name === "Alice");

    // User1 started with 100K, spent 500 on a bet
    // Balance should be 100_000 - 500 = 99_500
    expect(alice.balance).toBe(99_500);

    // Position value should be > 0 (shares have value based on AMM prices)
    expect(alice.positionValue).toBeGreaterThan(0);

    // totalWpm = balance + positionValue
    expect(alice.totalWpm).toBe(Math.round((alice.balance + alice.positionValue) * 100) / 100);
  });

  test("user without positions has positionValue of 0", async () => {
    const res = await app.request("/leaderboard/alltime", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();
    const bob = body.rankings.find((r: any) => r.name === "Bob");

    expect(bob.balance).toBe(50_000);
    expect(bob.positionValue).toBe(0);
    expect(bob.totalWpm).toBe(50_000);
  });

  test("rankings are deterministic — tiebreaker by walletAddress", async () => {
    // Make two requests and verify same order
    const res1 = await app.request("/leaderboard/alltime", {
      headers: { Authorization: `Bearer ${token1}` },
    });
    const res2 = await app.request("/leaderboard/alltime", {
      headers: { Authorization: `Bearer ${token2}` },
    });

    const body1 = await res1.json();
    const body2 = await res2.json();

    // Same order regardless of who requests
    expect(body1.rankings.map((r: any) => r.userId)).toEqual(
      body2.rankings.map((r: any) => r.userId),
    );
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/leaderboard/alltime");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
