import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import { calculateBuy } from "@wpm/shared/amm";
import type { CreateMarketTx, DistributeTx, PlaceBetTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14892;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-trading-buy-sell";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-trading-bs-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-bs-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
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
const richUserKeys = generateKeyPair(); // has plenty of WPM
const poorUserKeys = generateKeyPair(); // has very little WPM
const marketIdOpen = randomUUID(); // open, tradeable
const marketIdResolved = randomUUID(); // resolved
const marketIdExpired = randomUUID(); // open but past eventStartTime
const richUserId = randomUUID();
const poorUserId = randomUUID();

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let richToken: string;
let poorToken: string;

beforeAll(async () => {
  // 1. Bootstrap blockchain with genesis
  state = new ChainState(poaKeys.publicKey);
  const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
  state.applyBlock(genesis);

  mempool = new Mempool(oracleKeys.publicKey);
  eventBus = new EventBus();

  // 2. Create open market with seed (eventStartTime far in the future)
  const createMarketOpen: CreateMarketTx = {
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
  createMarketOpen.signature = sign(
    JSON.stringify({ ...createMarketOpen, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createMarketOpen, state);

  // 3. Create market that will be resolved
  const resolvedEventStart = Date.now() + 50;
  const createMarketResolved: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now() + 1,
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdResolved,
    sport: "MLB",
    homeTeam: "Yankees",
    awayTeam: "Red Sox",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: resolvedEventStart,
    seedAmount: 5000,
    externalEventId: randomUUID(),
  };
  createMarketResolved.signature = sign(
    JSON.stringify({ ...createMarketResolved, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createMarketResolved, state);

  // 4. Create market with very short eventStartTime (will expire by test time)
  const expiredEventStart = Date.now() + 80;
  const createMarketExpired: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now() + 2,
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: marketIdExpired,
    sport: "NFL",
    homeTeam: "Chiefs",
    awayTeam: "Eagles",
    outcomeA: "Home",
    outcomeB: "Away",
    eventStartTime: expiredEventStart,
    seedAmount: 5000,
    externalEventId: randomUUID(),
  };
  createMarketExpired.signature = sign(
    JSON.stringify({ ...createMarketExpired, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createMarketExpired, state);

  // 5. Distribute WPM: rich user gets 100K, poor user gets 5
  const distRich: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 3,
    sender: poaKeys.publicKey,
    recipient: richUserKeys.publicKey,
    amount: 100_000,
    reason: "signup_airdrop",
    signature: "",
  };
  distRich.signature = sign(
    JSON.stringify({ ...distRich, signature: undefined }),
    poaKeys.privateKey,
  );
  mempool.add(distRich, state);

  const distPoor: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 4,
    sender: poaKeys.publicKey,
    recipient: poorUserKeys.publicKey,
    amount: 5,
    reason: "signup_airdrop",
    signature: "",
  };
  distPoor.signature = sign(
    JSON.stringify({ ...distPoor, signature: undefined }),
    poaKeys.privateKey,
  );
  mempool.add(distPoor, state);

  // 6. Produce block to commit setup
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 7. Place a bet on marketIdOpen so richUser has shares
  const betTx: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 10,
    sender: richUserKeys.publicKey,
    signature: "",
    marketId: marketIdOpen,
    outcome: "A",
    amount: 500,
  };
  betTx.signature = sign(
    JSON.stringify({ ...betTx, signature: undefined }),
    richUserKeys.privateKey,
  );
  mempool.add(betTx, state);

  // 8. Produce block with bet
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 9. Resolve the resolved market
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

  // 10. Wait for expired market's eventStartTime to pass
  const waitMs = expiredEventStart - Date.now() + 10;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // 11. Start node HTTP API
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

  // 12. Seed SQLite with users
  const db = getDb();
  const encRichKey = await encryptPrivateKey(
    richUserKeys.privateKey,
    process.env.WALLET_ENCRYPTION_KEY!,
  );
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    richUserId,
    "Rich User",
    `rich-${randomUUID()}@example.com`,
    richUserKeys.publicKey,
    encRichKey,
    "user",
    Date.now(),
  );

  const encPoorKey = await encryptPrivateKey(
    poorUserKeys.privateKey,
    process.env.WALLET_ENCRYPTION_KEY!,
  );
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    poorUserId,
    "Poor User",
    `poor-${randomUUID()}@example.com`,
    poorUserKeys.publicKey,
    encPoorKey,
    "user",
    Date.now(),
  );

  // 13. Mint JWTs
  richToken = await signJwt({
    sub: richUserId,
    role: "user" as const,
    walletAddress: richUserKeys.publicKey,
    email: "rich@example.com",
  });

  poorToken = await signJwt({
    sub: poorUserId,
    role: "user" as const,
    walletAddress: poorUserKeys.publicKey,
    email: "poor@example.com",
  });

  // 14. Create Hono app with trading routes
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

describe("POST /markets/:marketId/buy — error cases", () => {
  test("rejects buy with 3+ decimal places → INVALID_AMOUNT (400)", async () => {
    const res = await app.request(`/markets/${marketIdOpen}/buy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 10.123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects buy on market past eventStartTime → MARKET_CLOSED (400)", async () => {
    const res = await app.request(`/markets/${marketIdExpired}/buy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_CLOSED");
  });

  test("rejects buy with insufficient balance → INSUFFICIENT_BALANCE (400)", async () => {
    // Poor user has only 5 WPM, tries to buy 100
    const res = await app.request(`/markets/${marketIdOpen}/buy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${poorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INSUFFICIENT_BALANCE");
  });

  test("rejects buy on resolved market → MARKET_ALREADY_RESOLVED (400)", async () => {
    const res = await app.request(`/markets/${marketIdResolved}/buy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 100 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_ALREADY_RESOLVED");
  });
});

describe("POST /markets/:marketId/sell — error cases", () => {
  test("rejects sell with 3+ decimal places → INVALID_AMOUNT (400)", async () => {
    const res = await app.request(`/markets/${marketIdOpen}/sell`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 10.123 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects sell on market past eventStartTime → MARKET_CLOSED (400)", async () => {
    const res = await app.request(`/markets/${marketIdExpired}/sell`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 10 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_CLOSED");
  });

  test("rejects sell with insufficient shares → INSUFFICIENT_SHARES (400)", async () => {
    // Rich user has shares from the 500 WPM bet, but not 99999
    const res = await app.request(`/markets/${marketIdOpen}/sell`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 99999 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INSUFFICIENT_SHARES");
  });

  test("rejects sell when user has zero shares of that outcome", async () => {
    // Poor user never bought any shares
    const res = await app.request(`/markets/${marketIdOpen}/sell`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${poorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 1 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INSUFFICIENT_SHARES");
  });

  test("rejects sell on resolved market → MARKET_ALREADY_RESOLVED (400)", async () => {
    const res = await app.request(`/markets/${marketIdResolved}/sell`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "A", amount: 10 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("MARKET_ALREADY_RESOLVED");
  });
});

describe("preview matches actual trade", () => {
  test("buy preview matches actual buy result with no intervening trades", async () => {
    // 1. Get buy preview
    const previewRes = await app.request(`/markets/${marketIdOpen}/buy/preview`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "B", amount: 200 }),
    });

    expect(previewRes.status).toBe(200);
    const preview = await previewRes.json();

    // 2. Get pool state before trade
    const poolBefore = state.pools.get(marketIdOpen)!;
    const expectedBuy = calculateBuy(poolBefore, "B", 200);

    // 3. Execute actual buy
    const buyRes = await app.request(`/markets/${marketIdOpen}/buy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${richToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcome: "B", amount: 200 }),
    });

    expect(buyRes.status).toBe(202);

    // 4. Produce block to commit the trade
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // 5. Verify preview matched AMM calculation
    expect(preview.sharesReceived).toBe(expectedBuy.sharesToUser);
    expect(preview.fee).toBe(Math.round(200 * 0.01 * 100) / 100); // 1% of 200
  });
});
