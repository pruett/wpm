import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign as cryptoSign } from "@wpm/shared/crypto";
import type { CreateMarketTx, ResolveMarketTx, CancelMarketTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports) ---
const NODE_PORT = 14820;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-oracle";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-oracle-route-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-oracle-route-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { oracle } = await import("../src/routes/oracle");
const { closeDb } = await import("../src/db/index");

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
const fakeKeys = generateKeyPair(); // non-oracle key pair for invalid signature tests

process.env.ORACLE_PUBLIC_KEY = oracleKeys.publicKey;

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;

// Market IDs for test fixtures
const market1Id = randomUUID();
const market2Id = randomUUID();
const market3Id = randomUUID();

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

  // 3. Create markets via oracle-signed transactions for GET /oracle/markets tests
  const eventStartTime = Date.now() + 3_600_000; // 1 hour from now

  // Market 1: open
  const createTx1: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market1Id,
    sport: "soccer",
    homeTeam: "Team A",
    awayTeam: "Team B",
    outcomeA: "Team A wins",
    outcomeB: "Team B wins",
    eventStartTime,
    seedAmount: 1000,
    externalEventId: `ext-${randomUUID()}`,
  };
  createTx1.signature = cryptoSign(
    JSON.stringify({ ...createTx1, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createTx1, state);

  // Market 2: will be resolved
  const createTx2: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market2Id,
    sport: "basketball",
    homeTeam: "Team C",
    awayTeam: "Team D",
    outcomeA: "Team C wins",
    outcomeB: "Team D wins",
    eventStartTime: Date.now() + 1000, // very near future
    seedAmount: 2000,
    externalEventId: `ext-${randomUUID()}`,
  };
  createTx2.signature = cryptoSign(
    JSON.stringify({ ...createTx2, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createTx2, state);

  // Market 3: will be cancelled
  const createTx3: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market3Id,
    sport: "tennis",
    homeTeam: "Player E",
    awayTeam: "Player F",
    outcomeA: "Player E wins",
    outcomeB: "Player F wins",
    eventStartTime,
    seedAmount: 500,
    externalEventId: `ext-${randomUUID()}`,
  };
  createTx3.signature = cryptoSign(
    JSON.stringify({ ...createTx3, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(createTx3, state);

  // Produce block to commit all 3 markets
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // Wait for market2 eventStartTime to pass so we can resolve it
  await new Promise((resolve) => setTimeout(resolve, 1200));

  // Resolve market 2
  const resolveTx: ResolveMarketTx = {
    id: randomUUID(),
    type: "ResolveMarket",
    timestamp: Math.max(Date.now(), createTx2.eventStartTime),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market2Id,
    winningOutcome: "A",
    finalScore: "100-95",
  };
  resolveTx.signature = cryptoSign(
    JSON.stringify({ ...resolveTx, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(resolveTx, state);

  // Cancel market 3
  const cancelTx: CancelMarketTx = {
    id: randomUUID(),
    type: "CancelMarket",
    timestamp: Date.now(),
    sender: oracleKeys.publicKey,
    signature: "",
    marketId: market3Id,
    reason: "Event postponed",
  };
  cancelTx.signature = cryptoSign(
    JSON.stringify({ ...cancelTx, signature: undefined }),
    oracleKeys.privateKey,
  );
  mempool.add(cancelTx, state);

  // Produce block to commit resolve + cancel
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 4. Create Hono app with oracle routes
  app = new Hono();
  app.route("/", oracle);
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

describe("POST /oracle/transaction", () => {
  test("valid oracle-signed CreateMarket tx is forwarded and accepted", async () => {
    const tx: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey,
      signature: "",
      marketId: randomUUID(),
      sport: "hockey",
      homeTeam: "Team G",
      awayTeam: "Team H",
      outcomeA: "Team G wins",
      outcomeB: "Team H wins",
      eventStartTime: Date.now() + 3_600_000,
      seedAmount: 1500,
      externalEventId: `ext-${randomUUID()}`,
    };
    tx.signature = cryptoSign(
      JSON.stringify({ ...tx, signature: undefined }),
      oracleKeys.privateKey,
    );

    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tx),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.txId).toBeDefined();
    expect(body.status).toBe("accepted");
  });

  test("tx is actually submitted to node mempool and processed", async () => {
    const newMarketId = randomUUID();
    const tx: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey,
      signature: "",
      marketId: newMarketId,
      sport: "baseball",
      homeTeam: "Team I",
      awayTeam: "Team J",
      outcomeA: "Team I wins",
      outcomeB: "Team J wins",
      eventStartTime: Date.now() + 3_600_000,
      seedAmount: 800,
      externalEventId: `ext-${randomUUID()}`,
    };
    tx.signature = cryptoSign(
      JSON.stringify({ ...tx, signature: undefined }),
      oracleKeys.privateKey,
    );

    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tx),
    });
    expect(res.status).toBe(202);

    // Produce block to commit the transaction
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // Verify market exists in chain state
    const market = state.markets.get(newMarketId);
    expect(market).toBeDefined();
    expect(market!.sport).toBe("baseball");
    expect(market!.status).toBe("open");
  });

  test("rejects tx signed by non-oracle key (wrong sender)", async () => {
    const tx: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: fakeKeys.publicKey, // wrong sender
      signature: "",
      marketId: randomUUID(),
      sport: "soccer",
      homeTeam: "A",
      awayTeam: "B",
      outcomeA: "A wins",
      outcomeB: "B wins",
      eventStartTime: Date.now() + 3_600_000,
      seedAmount: 1000,
      externalEventId: `ext-${randomUUID()}`,
    };
    tx.signature = cryptoSign(JSON.stringify({ ...tx, signature: undefined }), fakeKeys.privateKey);

    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tx),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("oracle");
  });

  test("rejects tx with invalid signature (tampered data)", async () => {
    const tx: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey,
      signature: "",
      marketId: randomUUID(),
      sport: "soccer",
      homeTeam: "A",
      awayTeam: "B",
      outcomeA: "A wins",
      outcomeB: "B wins",
      eventStartTime: Date.now() + 3_600_000,
      seedAmount: 1000,
      externalEventId: `ext-${randomUUID()}`,
    };
    // Sign with oracle key
    tx.signature = cryptoSign(
      JSON.stringify({ ...tx, signature: undefined }),
      oracleKeys.privateKey,
    );

    // Tamper with the data after signing
    tx.seedAmount = 999999;

    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tx),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("Invalid oracle signature");
  });

  test("rejects tx signed by wrong private key but correct sender field", async () => {
    const tx: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey, // correct sender
      signature: "",
      marketId: randomUUID(),
      sport: "soccer",
      homeTeam: "A",
      awayTeam: "B",
      outcomeA: "A wins",
      outcomeB: "B wins",
      eventStartTime: Date.now() + 3_600_000,
      seedAmount: 1000,
      externalEventId: `ext-${randomUUID()}`,
    };
    // Sign with WRONG private key
    tx.signature = cryptoSign(JSON.stringify({ ...tx, signature: undefined }), fakeKeys.privateKey);

    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tx),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toContain("Invalid oracle signature");
  });

  test("rejects tx with missing signature", async () => {
    const tx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oracleKeys.publicKey,
      // no signature field
      marketId: randomUUID(),
      sport: "soccer",
      homeTeam: "A",
      awayTeam: "B",
      outcomeA: "A wins",
      outcomeB: "B wins",
      eventStartTime: Date.now() + 3_600_000,
      seedAmount: 1000,
      externalEventId: `ext-${randomUUID()}`,
    };

    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tx),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects invalid JSON body", async () => {
    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects tx with missing sender", async () => {
    const res = await app.request("/oracle/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: randomUUID(), type: "CreateMarket", signature: "abc" }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("GET /oracle/markets", () => {
  test("returns all markets when no status filter", async () => {
    const res = await app.request("/oracle/markets");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    // At least: market1 (open) + market2 (resolved) + market3 (cancelled) + markets from POST tests
    expect(body.markets.length).toBeGreaterThanOrEqual(3);
  });

  test("filters by status=open", async () => {
    const res = await app.request("/oracle/markets?status=open");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    for (const m of body.markets) {
      expect(m.status).toBe("open");
    }
    // At least market1 is open
    expect(body.markets.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by status=resolved", async () => {
    const res = await app.request("/oracle/markets?status=resolved");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    for (const m of body.markets) {
      expect(m.status).toBe("resolved");
    }
    expect(body.markets.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by status=cancelled", async () => {
    const res = await app.request("/oracle/markets?status=cancelled");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    for (const m of body.markets) {
      expect(m.status).toBe("cancelled");
    }
    expect(body.markets.length).toBeGreaterThanOrEqual(1);
  });

  test("filters by comma-separated statuses (open,resolved)", async () => {
    const res = await app.request("/oracle/markets?status=open,resolved");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    for (const m of body.markets) {
      expect(["open", "resolved"]).toContain(m.status);
    }
    expect(body.markets.length).toBeGreaterThanOrEqual(2);
  });

  test("filters by all three statuses", async () => {
    const res = await app.request("/oracle/markets?status=open,resolved,cancelled");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    expect(body.markets.length).toBeGreaterThanOrEqual(3);
  });

  test("returns empty array for invalid status value", async () => {
    const res = await app.request("/oracle/markets?status=invalid");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toEqual([]);
  });

  test("handles mixed valid/invalid status values", async () => {
    const res = await app.request("/oracle/markets?status=open,invalid,resolved");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets).toBeArray();
    for (const m of body.markets) {
      expect(["open", "resolved"]).toContain(m.status);
    }
  });
});
