import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { PlaceBetTx, DistributeTx, CreateMarketTx, TransferTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14590;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-wallet";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-wallet-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-wallet-${randomUUID()}.jsonl`);

// --- Dynamic imports ---
const { wallet } = await import("../src/routes/wallet");
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
const user2Keys = generateKeyPair();
const marketId = randomUUID();
const userId = randomUUID();
const user2Id = randomUUID();

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

  // 2. Create a market (signed by oracle)
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

  // 3. Distribute WPM to both test users
  const dist1: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now(),
    sender: poaKeys.publicKey,
    recipient: userKeys.publicKey,
    amount: 100_000,
    reason: "signup_airdrop",
    signature: "",
  };
  dist1.signature = sign(JSON.stringify({ ...dist1, signature: undefined }), poaKeys.privateKey);
  mempool.add(dist1, state);

  const dist2: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 1,
    sender: poaKeys.publicKey,
    recipient: user2Keys.publicKey,
    amount: 50_000,
    reason: "signup_airdrop",
    signature: "",
  };
  dist2.signature = sign(JSON.stringify({ ...dist2, signature: undefined }), poaKeys.privateKey);
  mempool.add(dist2, state);

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

  // 5. User1 places a bet and user2 transfers to user1
  const betTx: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now() + 10,
    sender: userKeys.publicKey,
    signature: "",
    marketId,
    outcome: "A",
    amount: 500,
  };
  betTx.signature = sign(JSON.stringify({ ...betTx, signature: undefined }), userKeys.privateKey);
  mempool.add(betTx, state);

  const transferTx: TransferTx = {
    id: randomUUID(),
    type: "Transfer",
    timestamp: Date.now() + 20,
    sender: user2Keys.publicKey,
    recipient: userKeys.publicKey,
    amount: 1000,
    signature: "",
  };
  transferTx.signature = sign(
    JSON.stringify({ ...transferTx, signature: undefined }),
    user2Keys.privateKey,
  );
  mempool.add(transferTx, state);

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

  // 8. Seed SQLite with users
  const db = getDb();
  const encKey1 = await encryptPrivateKey(userKeys.privateKey, process.env.WALLET_ENCRYPTION_KEY!);
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(userId, "User One", "user1@example.com", userKeys.publicKey, encKey1, "user", Date.now());

  const encKey2 = await encryptPrivateKey(user2Keys.privateKey, process.env.WALLET_ENCRYPTION_KEY!);
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(user2Id, "User Two", "user2@example.com", user2Keys.publicKey, encKey2, "user", Date.now());

  // 9. Mint JWTs
  token = await signJwt({
    sub: userId,
    role: "user" as const,
    walletAddress: userKeys.publicKey,
    email: "user1@example.com",
  });

  token2 = await signJwt({
    sub: user2Id,
    role: "user" as const,
    walletAddress: user2Keys.publicKey,
    email: "user2@example.com",
  });

  tokenNoWallet = await signJwt({
    sub: randomUUID(),
    role: "user" as const,
  });

  // 10. Create Hono app with wallet routes
  app = new Hono();
  app.route("/", wallet);
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

describe("GET /wallet/balance", () => {
  test("returns balance matching node", async () => {
    const res = await app.request("/wallet/balance", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(userKeys.publicKey);
    // User1 started with 100K, spent 500 on bet, received 1000 transfer
    expect(body.balance).toBe(100_000 - 500 + 1000);
  });

  test("returns balance for user2", async () => {
    const res = await app.request("/wallet/balance", {
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.address).toBe(user2Keys.publicKey);
    // User2 started with 50K, sent 1000 transfer
    expect(body.balance).toBe(50_000 - 1000);
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/wallet/balance");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects token without wallet address", async () => {
    const res = await app.request("/wallet/balance", {
      headers: { Authorization: `Bearer ${tokenNoWallet}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Token missing wallet address");
  });
});

describe("GET /wallet/transactions", () => {
  test("returns user transactions sorted by timestamp desc", async () => {
    const res = await app.request("/wallet/transactions", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // User1 is involved in: Distribute (recipient), PlaceBet (sender), Transfer (recipient)
    expect(body.total).toBe(3);
    expect(body.transactions.length).toBe(3);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);

    // Verify descending timestamp order
    for (let i = 1; i < body.transactions.length; i++) {
      expect(body.transactions[i - 1].timestamp).toBeGreaterThanOrEqual(
        body.transactions[i].timestamp,
      );
    }

    // Verify transaction types present
    const types = body.transactions.map((tx: any) => tx.type);
    expect(types).toContain("Distribute");
    expect(types).toContain("PlaceBet");
    expect(types).toContain("Transfer");
  });

  test("returns user2 transactions", async () => {
    const res = await app.request("/wallet/transactions", {
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // User2 is involved in: Distribute (recipient), Transfer (sender)
    expect(body.total).toBe(2);
    const types = body.transactions.map((tx: any) => tx.type);
    expect(types).toContain("Distribute");
    expect(types).toContain("Transfer");
  });

  test("pagination with limit and offset", async () => {
    const res = await app.request("/wallet/transactions?limit=2&offset=0", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions.length).toBe(2);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);

    // Fetch next page
    const res2 = await app.request("/wallet/transactions?limit=2&offset=2", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body2 = await res2.json();
    expect(body2.transactions.length).toBe(1);
    expect(body2.total).toBe(3);
    expect(body2.offset).toBe(2);
  });

  test("limit clamped to 200", async () => {
    const res = await app.request("/wallet/transactions?limit=500", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(200);
  });

  test("rejects request without auth", async () => {
    const res = await app.request("/wallet/transactions");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects token without wallet address", async () => {
    const res = await app.request("/wallet/transactions", {
      headers: { Authorization: `Bearer ${tokenNoWallet}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
