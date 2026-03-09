import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { CreateMarketTx, DistributeTx, PlaceBetTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14587;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-sse-reconnect";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-sse-reconnect-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-sse-reconnect-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { events } = await import("../src/routes/events");
const { signJwt } = await import("../src/middleware/auth");
const { encryptPrivateKey } = await import("../src/crypto/wallet");
const { getDb, closeDb } = await import("../src/db/index");
const { createRelay, SSERelay } = await import("../src/sse/relay");

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
let token2: string;
const userId2 = randomUUID();

// Helper to read SSE events from a response until a target event appears
// targetCount allows waiting for multiple occurrences of the target event
async function readSSEUntil(
  res: Response,
  targetEvent: string,
  timeoutMs = 5000,
  targetCount = 1,
): Promise<{ allText: string; events: { event: string; data: string; id?: string }[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
    const allText = chunks.join("");
    // Count occurrences of the target event
    const count = allText.split(`event: ${targetEvent}`).length - 1;
    if (count >= targetCount) break;
  }

  reader.cancel();
  const allText = chunks.join("");

  // Parse SSE events from raw text
  const parsed: { event: string; data: string; id?: string }[] = [];
  const eventBlocks = allText.split("\n\n").filter(Boolean);
  for (const block of eventBlocks) {
    let event = "";
    let data = "";
    let id: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
      else if (line.startsWith("id: ")) id = line.slice(4);
    }
    if (event && data) {
      parsed.push({ event, data, id });
    }
  }

  return { allText, events: parsed };
}

describe("SSE reconnection: Last-Event-ID replay", () => {
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

    // 4. Produce block 1 (genesis was block 0)
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // 5. Place a bet — this creates block 2 with a trade
    const placeBetTx: PlaceBetTx = {
      id: randomUUID(),
      type: "PlaceBet",
      timestamp: Date.now(),
      sender: userKeys.publicKey,
      signature: "",
      marketId,
      outcome: "A",
      amount: 100,
    };
    placeBetTx.signature = sign(
      JSON.stringify({ ...placeBetTx, signature: undefined }),
      userKeys.privateKey,
    );
    mempool.add(placeBetTx, state);

    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // 6. Start node HTTP API
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

    // 7. Create SSE relay and connect to node
    const relay = createRelay(`http://127.0.0.1:${NODE_PORT}`);
    relay.connect();
    await new Promise((r) => setTimeout(r, 100));

    // 8. Seed SQLite users
    const db = getDb();
    const encryptedKey = await encryptPrivateKey(
      userKeys.privateKey,
      process.env.WALLET_ENCRYPTION_KEY!,
    );
    db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      userId,
      "Reconnect Test User",
      "reconnect-test@example.com",
      userKeys.publicKey,
      encryptedKey,
      "user",
      Date.now(),
    );

    // Second user for separate connections
    const user2Keys = generateKeyPair();
    const encryptedKey2 = await encryptPrivateKey(
      user2Keys.privateKey,
      process.env.WALLET_ENCRYPTION_KEY!,
    );
    db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      userId2,
      "Reconnect User 2",
      "reconnect-test2@example.com",
      user2Keys.publicKey,
      encryptedKey2,
      "user",
      Date.now(),
    );

    // 9. Mint JWTs
    token = await signJwt({
      sub: userId,
      role: "user" as const,
      walletAddress: userKeys.publicKey,
      email: "reconnect-test@example.com",
    });

    token2 = await signJwt({
      sub: userId2,
      role: "user" as const,
      walletAddress: user2Keys.publicKey,
      email: "reconnect-test2@example.com",
    });

    // 10. Create Hono app with event routes
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

  test("block:new events include id field with block index", async () => {
    // Connect client and produce a new block to get a live block:new event
    const res = await app.request(`/events/stream?token=${token}`);
    expect(res.status).toBe(200);

    // Place another bet to trigger events
    const placeBetTx: PlaceBetTx = {
      id: randomUUID(),
      type: "PlaceBet",
      timestamp: Date.now(),
      sender: userKeys.publicKey,
      signature: "",
      marketId,
      outcome: "B",
      amount: 50,
    };
    placeBetTx.signature = sign(
      JSON.stringify({ ...placeBetTx, signature: undefined }),
      userKeys.privateKey,
    );
    mempool.add(placeBetTx, state);

    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    const { events: parsedEvents } = await readSSEUntil(res, "block:new");

    // Find block:new event
    const blockNewEvent = parsedEvents.find((e) => e.event === "block:new");
    expect(blockNewEvent).toBeDefined();
    expect(blockNewEvent!.id).toBeDefined();
    // id should be the block index (a numeric string)
    expect(parseInt(blockNewEvent!.id!, 10)).toBeGreaterThanOrEqual(1);
  });

  test("reconnection with Last-Event-ID=0 replays blocks from index 1 onward", async () => {
    // Connect with Last-Event-ID=0 (genesis block) — should replay blocks 1, 2, 3
    const res = await app.request(`/events/stream?token=${token2}`, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(200);

    // Read events — replay should include block:new events for blocks 1+
    const { events: parsedEvents } = await readSSEUntil(res, "block:new");

    // Should have at least one block:new from the replay
    const blockNewEvents = parsedEvents.filter((e) => e.event === "block:new");
    expect(blockNewEvents.length).toBeGreaterThanOrEqual(1);

    // The first replayed block:new should have id "1" (block index 1)
    const firstBlockNew = blockNewEvents[0];
    expect(firstBlockNew.id).toBe("1");
    const firstData = JSON.parse(firstBlockNew.data);
    expect(firstData.blockIndex).toBe(1);
  });

  test("reconnection replays market:created events from missed blocks", async () => {
    // Block 1 contains CreateMarket + Distribute — connect with Last-Event-ID=0
    const res = await app.request(`/events/stream?token=${token2}`, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(200);

    const { events: parsedEvents } = await readSSEUntil(res, "block:new");

    // Should have market:created event from block 1's CreateMarket tx
    const marketCreatedEvents = parsedEvents.filter((e) => e.event === "market:created");
    expect(marketCreatedEvents.length).toBeGreaterThanOrEqual(1);

    const marketData = JSON.parse(marketCreatedEvents[0].data);
    expect(marketData.marketId).toBe(marketId);
    expect(marketData.sport).toBe("NBA");
    expect(marketData.homeTeam).toBe("Lakers");
    expect(marketData.awayTeam).toBe("Celtics");
  });

  test("reconnection replays price:update and bet:placed events from missed blocks", async () => {
    // Block 2 contains PlaceBet — connect with Last-Event-ID=1 to skip block 1
    const res = await app.request(`/events/stream?token=${token2}`, {
      headers: { "Last-Event-ID": "1" },
    });
    expect(res.status).toBe(200);

    const { events: parsedEvents } = await readSSEUntil(res, "block:new");

    // Should have price:update from the PlaceBet in block 2
    const priceUpdateEvents = parsedEvents.filter((e) => e.event === "price:update");
    expect(priceUpdateEvents.length).toBeGreaterThanOrEqual(1);

    const priceData = JSON.parse(priceUpdateEvents[0].data);
    expect(priceData.marketId).toBe(marketId);
    expect(typeof priceData.priceA).toBe("number");
    expect(typeof priceData.priceB).toBe("number");
    expect(typeof priceData.totalVolume).toBe("number");
    expect(priceData.totalVolume).toBeGreaterThan(0);

    // Should have bet:placed
    const betPlacedEvents = parsedEvents.filter((e) => e.event === "bet:placed");
    expect(betPlacedEvents.length).toBeGreaterThanOrEqual(1);

    const betData = JSON.parse(betPlacedEvents[0].data);
    expect(betData.marketId).toBe(marketId);
    expect(betData.userName).toBe("Reconnect Test User");
  });

  test("reconnection with lastEventId query param works", async () => {
    // Use query param instead of header
    const res = await app.request(`/events/stream?token=${token2}&lastEventId=0`);
    expect(res.status).toBe(200);

    const { events: parsedEvents } = await readSSEUntil(res, "block:new");

    // Should have replayed events from block 1+
    const blockNewEvents = parsedEvents.filter((e) => e.event === "block:new");
    expect(blockNewEvents.length).toBeGreaterThanOrEqual(1);
    expect(blockNewEvents[0].id).toBe("1");
  });

  test("reconnection with Last-Event-ID at current block replays nothing", async () => {
    // Get current block height
    const healthRes = await fetch(`http://127.0.0.1:${NODE_PORT}/internal/health`);
    const health = (await healthRes.json()) as { blockHeight: number };
    const currentBlock = health.blockHeight - 1; // block index is 0-based

    // Connect with Last-Event-ID = current block — nothing to replay
    const res = await app.request(`/events/stream?token=${token2}`, {
      headers: { "Last-Event-ID": String(currentBlock) },
    });
    expect(res.status).toBe(200);

    // Read briefly — should not receive any replayed block:new events
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Wait a short time for any replay to complete
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), 500),
    );
    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    reader.cancel();

    // Either timed out (no data) or received only keepalive
    if (!done && value) {
      const text = decoder.decode(value);
      // Should not contain any block:new events from replay
      expect(text).not.toContain("event: block:new");
    }
  });

  test("reconnection replays multiple blocks in order", async () => {
    // Connect with Last-Event-ID=0 to replay all blocks (1, 2, 3)
    const res = await app.request(`/events/stream?token=${token2}`, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(200);

    // Wait for at least 2 block:new events from replay
    const { events: parsedEvents } = await readSSEUntil(res, "block:new", 8000, 2);

    // Should have multiple block:new events with ascending indices
    const blockNewEvents = parsedEvents.filter((e) => e.event === "block:new");
    expect(blockNewEvents.length).toBeGreaterThanOrEqual(2);

    // Verify block indices are in order
    const indices = blockNewEvents.map((e) => JSON.parse(e.data).blockIndex);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  test("each block:new event in replay includes correct id field", async () => {
    const res = await app.request(`/events/stream?token=${token2}`, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(200);

    const { events: parsedEvents } = await readSSEUntil(res, "block:new", 8000, 2);

    const blockNewEvents = parsedEvents.filter((e) => e.event === "block:new");
    for (const evt of blockNewEvents) {
      const data = JSON.parse(evt.data);
      // id field should match blockIndex
      expect(evt.id).toBe(String(data.blockIndex));
    }
  });

  test("non-block:new events in replay do not have id field", async () => {
    const res = await app.request(`/events/stream?token=${token2}`, {
      headers: { "Last-Event-ID": "0" },
    });
    expect(res.status).toBe(200);

    const { events: parsedEvents } = await readSSEUntil(res, "block:new", 8000, 2);

    const nonBlockEvents = parsedEvents.filter((e) => e.event !== "block:new");
    for (const evt of nonBlockEvents) {
      expect(evt.id).toBeUndefined();
    }
  });
});
