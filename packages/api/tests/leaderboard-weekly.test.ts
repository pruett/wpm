import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { PlaceBetTx, DistributeTx, CreateMarketTx, TransferTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14730;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-weekly-lb";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-weekly-lb-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-weekly-lb-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const {
  leaderboard: leaderboardRoutes,
  getWeekStartTimestamp,
  StateSnapshot,
} = await import("../src/routes/leaderboard");
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

  // 3. Distribute to users — all happen NOW (within the current week)
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

  // 4. Produce block 1 — setup txs committed
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 5. User1 places a bet (spends 1000 WPM, getting shares)
  const bet1: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 10,
    sender: user1Keys.publicKey,
    signature: "",
    marketId,
    outcome: "A",
    amount: 1000,
  };
  bet1.signature = sign(JSON.stringify({ ...bet1, signature: undefined }), user1Keys.privateKey);
  mempool.add(bet1, state);

  // 6. User2 transfers 5000 WPM to user3
  const transfer: TransferTx = {
    id: randomUUID(),
    type: "Transfer",
    timestamp: Date.now() + 11,
    sender: user2Keys.publicKey,
    signature: "",
    recipient: user3Keys.publicKey,
    amount: 5000,
  };
  transfer.signature = sign(
    JSON.stringify({ ...transfer, signature: undefined }),
    user2Keys.privateKey,
  );
  mempool.add(transfer, state);

  // 7. Produce block 2 — bets + transfers committed
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

  // 9. Seed SQLite with users
  const db = getDb();
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    user1Id,
    "Alice",
    "alice-w@example.com",
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
    "bob-w@example.com",
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
    "charlie-w@example.com",
    user3Keys.publicKey,
    Buffer.from("placeholder"),
    "user",
    Date.now(),
  );

  // 10. Mint JWTs
  token1 = await signJwt({
    sub: user1Id,
    role: "user" as const,
    walletAddress: user1Keys.publicKey,
    email: "alice-w@example.com",
  });

  token2 = await signJwt({
    sub: user2Id,
    role: "user" as const,
    walletAddress: user2Keys.publicKey,
    email: "bob-w@example.com",
  });

  token3 = await signJwt({
    sub: user3Id,
    role: "user" as const,
    walletAddress: user3Keys.publicKey,
    email: "charlie-w@example.com",
  });

  // 11. Create Hono app with leaderboard routes
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

describe("GET /leaderboard/weekly", () => {
  test("returns rankings for all users sorted by weeklyPnl descending", async () => {
    const res = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.rankings).toBeArray();
    expect(body.rankings.length).toBe(3);

    // All activity happened this week, so weeklyPnl should be positive for all users
    // since they all received distributions this week
    for (const entry of body.rankings) {
      expect(entry.weeklyPnl).toBeGreaterThan(0);
    }

    // Rankings should be sorted by weeklyPnl descending
    for (let i = 1; i < body.rankings.length; i++) {
      expect(body.rankings[i - 1].weeklyPnl).toBeGreaterThanOrEqual(body.rankings[i].weeklyPnl);
    }
  });

  test("includes correct fields in each ranking entry", async () => {
    const res = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();
    const entry = body.rankings[0];

    expect(entry.rank).toBeNumber();
    expect(entry.userId).toBeString();
    expect(entry.name).toBeString();
    expect(entry.walletAddress).toBeString();
    expect(entry.currentTotalWpm).toBeNumber();
    expect(entry.weekStartTotalWpm).toBeNumber();
    expect(entry.weeklyPnl).toBeNumber();
  });

  test("includes weekStart timestamp in response", async () => {
    const res = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();

    expect(body.weekStart).toBeNumber();
    // weekStart should be a Monday 00:00 UTC
    const weekStartDate = new Date(body.weekStart);
    expect(weekStartDate.getUTCDay()).toBe(1); // Monday
    expect(weekStartDate.getUTCHours()).toBe(0);
    expect(weekStartDate.getUTCMinutes()).toBe(0);
    expect(weekStartDate.getUTCSeconds()).toBe(0);
  });

  test("weeklyPnl reflects all activity since week start", async () => {
    const res = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();

    // Since all blocks happened this week (timestamps are Date.now()), and there were
    // no blocks before the week started, weekStartTotalWpm should be 0 for all users
    for (const entry of body.rankings) {
      expect(entry.weekStartTotalWpm).toBe(0);
      // weeklyPnl = currentTotalWpm - 0 = currentTotalWpm
      expect(entry.weeklyPnl).toBe(entry.currentTotalWpm);
    }
  });

  test("user with bet has weeklyPnl reflecting position value", async () => {
    const res = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();
    const alice = body.rankings.find((r: any) => r.name === "Alice");

    // Alice received 100K, spent 1K on bet → balance 99K + position value
    expect(alice.currentTotalWpm).toBeGreaterThan(99_000);
    expect(alice.weeklyPnl).toBe(alice.currentTotalWpm); // weekStartTotalWpm = 0
  });

  test("transfer between users is zero-sum in rankings", async () => {
    const res = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();
    const bob = body.rankings.find((r: any) => r.name === "Bob");
    const charlie = body.rankings.find((r: any) => r.name === "Charlie");

    // Bob got 50K airdrop, sent 5K to Charlie → balance 45K
    // Charlie got 25K airdrop, received 5K from Bob → balance 30K
    expect(bob.currentTotalWpm).toBe(45_000);
    expect(charlie.currentTotalWpm).toBe(30_000);
  });

  test("assigns 1-indexed ranks", async () => {
    const res = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });

    const body = await res.json();

    expect(body.rankings[0].rank).toBe(1);
    expect(body.rankings[1].rank).toBe(2);
    expect(body.rankings[2].rank).toBe(3);
  });

  test("rankings are deterministic — same result from different requesters", async () => {
    const res1 = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token1}` },
    });
    const res2 = await app.request("/leaderboard/weekly", {
      headers: { Authorization: `Bearer ${token2}` },
    });

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(body1.rankings.map((r: any) => r.userId)).toEqual(
      body2.rankings.map((r: any) => r.userId),
    );
    expect(body1.rankings.map((r: any) => r.weeklyPnl)).toEqual(
      body2.rankings.map((r: any) => r.weeklyPnl),
    );
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/leaderboard/weekly");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("getWeekStartTimestamp", () => {
  test("returns Monday 00:00 UTC for a Wednesday", () => {
    // 2026-03-11 is a Wednesday
    const wed = new Date(Date.UTC(2026, 2, 11, 14, 30, 0));
    const weekStart = getWeekStartTimestamp(wed);
    const d = new Date(weekStart);
    expect(d.getUTCDay()).toBe(1); // Monday
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(2); // March
    expect(d.getUTCDate()).toBe(9);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
  });

  test("returns Monday 00:00 UTC for a Monday", () => {
    // Monday itself should return that same Monday
    const mon = new Date(Date.UTC(2026, 2, 9, 10, 0, 0));
    const weekStart = getWeekStartTimestamp(mon);
    const d = new Date(weekStart);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCDate()).toBe(9);
    expect(d.getUTCHours()).toBe(0);
  });

  test("returns previous Monday for a Sunday", () => {
    // Sunday 2026-03-15 should go back to Monday 2026-03-09
    const sun = new Date(Date.UTC(2026, 2, 15, 23, 59, 59));
    const weekStart = getWeekStartTimestamp(sun);
    const d = new Date(weekStart);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCDate()).toBe(9);
  });

  test("returns previous Monday for a Saturday", () => {
    // Saturday 2026-03-14 should go back to Monday 2026-03-09
    const sat = new Date(Date.UTC(2026, 2, 14, 12, 0, 0));
    const weekStart = getWeekStartTimestamp(sat);
    const d = new Date(weekStart);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCDate()).toBe(9);
  });

  test("handles week crossing month boundary", () => {
    // 2026-04-01 is a Wednesday → Monday is 2026-03-30
    const wed = new Date(Date.UTC(2026, 3, 1, 8, 0, 0));
    const weekStart = getWeekStartTimestamp(wed);
    const d = new Date(weekStart);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCMonth()).toBe(2); // March
    expect(d.getUTCDate()).toBe(30);
  });

  test("handles week crossing year boundary", () => {
    // 2026-01-01 is a Thursday → Monday is 2025-12-29
    const thu = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const weekStart = getWeekStartTimestamp(thu);
    const d = new Date(weekStart);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(11); // December
    expect(d.getUTCDate()).toBe(29);
  });
});

describe("StateSnapshot", () => {
  test("replays blocks to produce correct balances", () => {
    // Simulate a simple chain: genesis distribute + transfer
    const treasury = "TREASURY_KEY";
    const snap = new StateSnapshot(treasury);

    const block1 = {
      index: 0,
      timestamp: 1000,
      transactions: [
        {
          id: "tx1",
          type: "Distribute" as const,
          timestamp: 1000,
          sender: treasury,
          recipient: treasury,
          amount: 10_000_000,
          reason: "genesis" as const,
          signature: "",
        },
      ],
      previousHash: "0",
      hash: "abc",
      signature: "",
    };

    const block2 = {
      index: 1,
      timestamp: 2000,
      transactions: [
        {
          id: "tx2",
          type: "Distribute" as const,
          timestamp: 2000,
          sender: treasury,
          recipient: "USER_A",
          amount: 100_000,
          reason: "signup_airdrop" as const,
          signature: "",
        },
        {
          id: "tx3",
          type: "Transfer" as const,
          timestamp: 2001,
          sender: "USER_A",
          recipient: "USER_B",
          amount: 5000,
          signature: "",
        },
      ],
      previousHash: "abc",
      hash: "def",
      signature: "",
    };

    snap.applyBlock(block1);
    expect(snap.getBalance(treasury)).toBe(10_000_000);

    snap.applyBlock(block2);
    expect(snap.getBalance(treasury)).toBe(10_000_000 - 100_000);
    expect(snap.getBalance("USER_A")).toBe(100_000 - 5000);
    expect(snap.getBalance("USER_B")).toBe(5000);
  });

  test("stops at boundary block to give historical state", () => {
    const treasury = "TREASURY_KEY";
    const snap = new StateSnapshot(treasury);
    const weekBoundary = 5000;

    const blocks = [
      {
        index: 0,
        timestamp: 1000,
        transactions: [
          {
            id: "g1",
            type: "Distribute" as const,
            timestamp: 1000,
            sender: treasury,
            recipient: treasury,
            amount: 10_000_000,
            reason: "genesis" as const,
            signature: "",
          },
        ],
        previousHash: "0",
        hash: "a",
        signature: "",
      },
      {
        index: 1,
        timestamp: 3000,
        transactions: [
          {
            id: "d1",
            type: "Distribute" as const,
            timestamp: 3000,
            sender: treasury,
            recipient: "USER_A",
            amount: 50_000,
            reason: "signup_airdrop" as const,
            signature: "",
          },
        ],
        previousHash: "a",
        hash: "b",
        signature: "",
      },
      // This block is AFTER the week boundary — should not be applied
      {
        index: 2,
        timestamp: 6000,
        transactions: [
          {
            id: "d2",
            type: "Distribute" as const,
            timestamp: 6000,
            sender: treasury,
            recipient: "USER_A",
            amount: 100_000,
            reason: "signup_airdrop" as const,
            signature: "",
          },
        ],
        previousHash: "b",
        hash: "c",
        signature: "",
      },
    ];

    for (const block of blocks) {
      if (block.timestamp >= weekBoundary) break;
      snap.applyBlock(block);
    }

    // Only block 0 and 1 applied; block 2 (timestamp 6000) excluded
    expect(snap.getBalance("USER_A")).toBe(50_000);
  });
});
