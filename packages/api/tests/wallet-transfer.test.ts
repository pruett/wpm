import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import { generateKeyPair, sign } from "@wpm/shared/crypto";
import type { DistributeTx } from "@wpm/shared";

// --- Env setup (must run before dynamic imports that capture env at module level) ---
const NODE_PORT = 14793;
process.env.NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
process.env.JWT_SECRET = "test-jwt-secret-for-wallet-transfer";
process.env.WALLET_ENCRYPTION_KEY = "test-wallet-encryption-key-32ch";
const DB_PATH = join(tmpdir(), `wpm-wallet-transfer-${randomUUID()}.db`);
process.env.DB_PATH = DB_PATH;
const CHAIN_FILE = join(tmpdir(), `wpm-chain-transfer-${randomUUID()}.jsonl`);

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
const senderKeys = generateKeyPair();
const recipientKeys = generateKeyPair();
const senderId = randomUUID();
const recipientId = randomUUID();

let state: InstanceType<typeof ChainState>;
let mempool: InstanceType<typeof Mempool>;
let eventBus: InstanceType<typeof EventBus>;
let nodeApi: { server: any; close: () => Promise<void> };
let app: InstanceType<typeof Hono>;
let senderToken: string;
let recipientToken: string;

beforeAll(async () => {
  // 1. Bootstrap blockchain with genesis
  state = new ChainState(poaKeys.publicKey);
  const genesis = createGenesisBlock(poaKeys.publicKey, poaKeys.privateKey);
  state.applyBlock(genesis);

  mempool = new Mempool(oracleKeys.publicKey);
  eventBus = new EventBus();

  // 2. Distribute WPM to sender (100K) and recipient (10K)
  const distSender: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now(),
    sender: poaKeys.publicKey,
    recipient: senderKeys.publicKey,
    amount: 100_000,
    reason: "signup_airdrop",
    signature: "",
  };
  distSender.signature = sign(
    JSON.stringify({ ...distSender, signature: undefined }),
    poaKeys.privateKey,
  );
  mempool.add(distSender, state);

  const distRecipient: DistributeTx = {
    id: randomUUID(),
    type: "Distribute",
    timestamp: Date.now() + 1,
    sender: poaKeys.publicKey,
    recipient: recipientKeys.publicKey,
    amount: 10_000,
    reason: "signup_airdrop",
    signature: "",
  };
  distRecipient.signature = sign(
    JSON.stringify({ ...distRecipient, signature: undefined }),
    poaKeys.privateKey,
  );
  mempool.add(distRecipient, state);

  // 3. Produce block to commit setup
  produceBlock(
    state,
    mempool,
    poaKeys.publicKey,
    poaKeys.privateKey,
    CHAIN_FILE,
    oracleKeys.publicKey,
    eventBus,
  );

  // 4. Start node HTTP API
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

  // 5. Seed SQLite with users
  const db = getDb();
  const encSenderKey = await encryptPrivateKey(
    senderKeys.privateKey,
    process.env.WALLET_ENCRYPTION_KEY!,
  );
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    senderId,
    "Sender",
    `sender-${randomUUID()}@example.com`,
    senderKeys.publicKey,
    encSenderKey,
    "user",
    Date.now(),
  );

  const encRecipientKey = await encryptPrivateKey(
    recipientKeys.privateKey,
    process.env.WALLET_ENCRYPTION_KEY!,
  );
  db.query(
    "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    recipientId,
    "Recipient",
    `recipient-${randomUUID()}@example.com`,
    recipientKeys.publicKey,
    encRecipientKey,
    "user",
    Date.now(),
  );

  // 6. Mint JWTs
  senderToken = await signJwt({
    sub: senderId,
    role: "user" as const,
    walletAddress: senderKeys.publicKey,
    email: "sender@example.com",
  });

  recipientToken = await signJwt({
    sub: recipientId,
    role: "user" as const,
    walletAddress: recipientKeys.publicKey,
    email: "recipient@example.com",
  });

  // 7. Create Hono app with wallet routes
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

describe("POST /wallet/transfer", () => {
  test("valid transfer succeeds with 202 and correct response shape", async () => {
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: recipientKeys.publicKey,
        amount: 500,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.txId).toBeDefined();
    expect(body.recipient).toBe(recipientKeys.publicKey);
    expect(body.amount).toBe(500);
    expect(body.status).toBe("accepted");
  });

  test("transfer updates balances on node after block production", async () => {
    // Produce block to commit the transfer from previous test
    produceBlock(
      state,
      mempool,
      poaKeys.publicKey,
      poaKeys.privateKey,
      CHAIN_FILE,
      oracleKeys.publicKey,
      eventBus,
    );

    // Verify sender balance decreased
    const senderBalance = state.balances.get(senderKeys.publicKey) ?? 0;
    expect(senderBalance).toBe(100_000 - 500);

    // Verify recipient balance increased
    const recipientBalance = state.balances.get(recipientKeys.publicKey) ?? 0;
    expect(recipientBalance).toBe(10_000 + 500);
  });

  test("rejects self-transfer → INVALID_TRANSFER (400)", async () => {
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: senderKeys.publicKey,
        amount: 100,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_TRANSFER");
  });

  test("rejects unknown recipient → RECIPIENT_NOT_FOUND (404)", async () => {
    // Generate a random keypair not registered in the users table
    const unknownKeys = generateKeyPair();
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: unknownKeys.publicKey,
        amount: 100,
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("RECIPIENT_NOT_FOUND");
  });

  test("rejects missing recipientAddress → RECIPIENT_NOT_FOUND (404)", async () => {
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: 100,
      }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("RECIPIENT_NOT_FOUND");
  });

  test("rejects invalid amount with 3+ decimal places → INVALID_AMOUNT (400)", async () => {
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: recipientKeys.publicKey,
        amount: 10.123,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects zero amount → INVALID_AMOUNT (400)", async () => {
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: recipientKeys.publicKey,
        amount: 0,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects negative amount → INVALID_AMOUNT (400)", async () => {
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: recipientKeys.publicKey,
        amount: -50,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_AMOUNT");
  });

  test("rejects request without auth → UNAUTHORIZED (401)", async () => {
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: recipientKeys.publicKey,
        amount: 100,
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  test("rejects insufficient balance → INSUFFICIENT_BALANCE (400)", async () => {
    // Sender has ~99,500 WPM after the first transfer, try to send way more
    const res = await app.request("/wallet/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${senderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipientAddress: recipientKeys.publicKey,
        amount: 999_999,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INSUFFICIENT_BALANCE");
  });
});
