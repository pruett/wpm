import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { CreateMarketTx, DistributeTx, PlaceBetTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14569;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-tracer-sse";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-sse-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-sse-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { events } = await import("../src/routes/events");
const { signJwt } = await import("../src/middleware/auth");
const { encryptPrivateKey } = await import("../src/crypto/wallet");
const { getDb, closeDb } = await import("../src/db/index");
const { createRelay } = await import("../src/sse/relay");

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

describe("tracer-sse: GET /events/stream", () => {
  beforeAll(async () => {
    // 1. Bootstrap blockchain
    state = new ChainState(poaKeys.publicKey);
    const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
    state.applyBlock(genesis);

    mempool = new Mempool(oracleKeys.publicKey);
    eventBus = new EventBus();

    // 2. Create a market
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

    // 3. Distribute WPM to test user
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

    // 6. Create SSE relay and connect to node
    const relay = createRelay(`http://127.0.0.1:${NODE_PORT}`);
    relay.connect();
    // Give relay a moment to establish connection
    await new Promise((r) => setTimeout(r, 100));

    // 7. Seed SQLite user
    const db = getDb();
    const encryptedKey = await encryptPrivateKey(
      userKeys.privateKey,
      process.env.WALLET_ENCRYPTION_KEY!,
    );
    db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      userId,
      "SSE Test User",
      "sse-test@example.com",
      userKeys.publicKey,
      encryptedKey,
      "user",
      Date.now(),
    );

    // 8. Mint JWT
    token = await signJwt({
      sub: userId,
      role: "user" as const,
      walletAddress: userKeys.publicKey,
      email: "sse-test@example.com",
    });

    // 9. Create Hono app with event routes
    app = new Hono();
    app.route("/", events);
  });

  afterAll(async () => {
    const { getRelay } = await import("../src/sse/relay");
    try {
      getRelay().close();
    } catch {}
    eventBus.closeAll();
    await nodeApi.close();
    closeDb();
    for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm", CHAIN_FILE]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  });

  test("rejects request without token query param", async () => {
    const res = await app.request("/events/stream");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects request with invalid token", async () => {
    const res = await app.request("/events/stream?token=bad-token");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("returns SSE stream with valid token", async () => {
    const res = await app.request(`/events/stream?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    // Clean up the stream
    const reader = res.body!.getReader();
    reader.cancel();
  });

  test("receives transformed events after PlaceBet tx and block production", async () => {
    // 1. Connect SSE client
    const res = await app.request(`/events/stream?token=${token}`);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // 2. Submit a PlaceBet transaction via the node directly
    const placeBetTx: PlaceBetTx = {
      id: randomUUID(),
      type: "PlaceBet",
      timestamp: Date.now(),
      sender: userKeys.publicKey,
      signature: "",
      marketId,
      outcome: "A",
      amount: 50,
    };
    placeBetTx.signature = sign(
      JSON.stringify({ ...placeBetTx, signature: undefined }),
      userKeys.privateKey,
    );
    mempool.add(placeBetTx, state);

    // 3. Produce block (this triggers eventBus → relay → client)
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // 4. Read SSE events with a timeout — wait for block:new (last event in sequence)
    const receivedChunks: string[] = [];
    const readWithTimeout = async (timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        );
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        receivedChunks.push(decoder.decode(value, { stream: true }));
        // block:new is always the last event in a block's sequence
        const allText = receivedChunks.join("");
        if (allText.includes("block:new")) break;
      }
    };

    await readWithTimeout(5000);
    reader.cancel();

    // 5. Verify transformed events: trade:executed → price:update + bet:placed + balance:update
    const allText = receivedChunks.join("");

    // price:update with prices, multipliers, and totalVolume
    expect(allText).toContain("event: price:update");
    expect(allText).toContain(marketId);

    // Extract and verify price:update data includes totalVolume
    const priceUpdateMatch = allText.match(/event: price:update\ndata: (.+)\n/);
    expect(priceUpdateMatch).not.toBeNull();
    const priceUpdateData = JSON.parse(priceUpdateMatch![1]);
    expect(priceUpdateData.totalVolume).toBe(50); // 50 WPM from the PlaceBet tx

    // bet:placed with user info
    expect(allText).toContain("event: bet:placed");
    expect(allText).toContain("SSE Test User");

    // balance:update with address
    expect(allText).toContain("event: balance:update");

    // block:new with renamed fields
    expect(allText).toContain("event: block:new");
    expect(allText).toContain("blockIndex");
    expect(allText).toContain("transactionCount");

    // Should NOT contain raw node events
    expect(allText).not.toContain("event: trade:executed");
  });

  test("enforces 1 connection per user (new connection closes old)", async () => {
    const { getRelay } = await import("../src/sse/relay");
    const relay = getRelay();

    // Connect first client
    const res1 = await app.request(`/events/stream?token=${token}`);
    expect(res1.status).toBe(200);
    expect(relay.connectedClients).toBe(1);

    // Connect second client (same user) — should replace, not add
    const res2 = await app.request(`/events/stream?token=${token}`);
    expect(res2.status).toBe(200);
    expect(relay.connectedClients).toBe(1);

    // Clean up
    const reader2 = res2.body!.getReader();
    reader2.cancel();
  });
});
