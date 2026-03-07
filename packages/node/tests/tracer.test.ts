import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, sign } from "@wpm/shared";
import type { TransferTx } from "@wpm/shared";
import { createGenesisBlock } from "../src/genesis.js";
import { appendBlock } from "../src/persistence.js";
import { ChainState } from "../src/state.js";
import { Mempool } from "../src/mempool.js";
import { produceBlock } from "../src/producer.js";
import { startApi } from "../src/api.js";

const PORT = 0; // let OS pick a free port

function buildTransferTx(
  sender: string,
  recipient: string,
  amount: number,
  privateKey: string,
): TransferTx {
  const tx: TransferTx = {
    id: randomUUID(),
    type: "Transfer",
    timestamp: Date.now(),
    sender,
    recipient,
    amount,
    signature: "",
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, privateKey);
  return tx;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(base: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json() };
}

describe("Tracer bullet — full loop", () => {
  let tmpDir: string;
  let chainFilePath: string;
  let state: ChainState;
  let mempool: Mempool;
  let api: ReturnType<typeof startApi>;
  let baseUrl: string;

  let poaPublicKey: string;
  let poaPrivateKey: string;
  let userPublicKey: string;

  beforeAll(async () => {
    // Temp directory for chain file and keys
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-tracer-"));
    chainFilePath = join(tmpDir, "chain.jsonl");

    // Generate PoA keys (treasury = poaPublicKey)
    const poaKeys = generateKeyPair();
    poaPublicKey = poaKeys.publicKey;
    poaPrivateKey = poaKeys.privateKey;

    // Generate a user key pair
    const userKeys = generateKeyPair();
    userPublicKey = userKeys.publicKey;

    // Create genesis block → treasury gets 10M WPM
    const genesis = createGenesisBlock(poaPublicKey, poaPrivateKey);
    state = new ChainState(poaPublicKey);
    appendBlock(genesis, chainFilePath);
    state.applyBlock(genesis);

    // Start mempool + API
    mempool = new Mempool();
    api = startApi(state, mempool, { poaPublicKey, poaPrivateKey }, PORT, "127.0.0.1");

    // Wait for server to be listening
    await new Promise<void>((resolve) => {
      if (api.server.listening) return resolve();
      api.server.once("listening", resolve);
    });

    // Resolve the actual port assigned by the OS
    const addr = api.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
    baseUrl = `http://127.0.0.1:${actualPort}`;
  });

  afterAll(async () => {
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("health endpoint returns block height 1 after genesis", async () => {
    const { status, json } = await get(baseUrl, "/internal/health");
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: "ok", blockHeight: 1 });
  });

  it("treasury has 10M WPM after genesis", async () => {
    const encoded = encodeURIComponent(poaPublicKey);
    const { status, json } = await get(baseUrl, `/internal/balance/${encoded}`);
    expect(status).toBe(200);
    expect((json as { balance: number }).balance).toBe(10_000_000);
  });

  it("submit Transfer, produce block, verify balance change", async () => {
    const transferAmount = 100.5;

    // Build and submit a Transfer from treasury to user
    const tx = buildTransferTx(poaPublicKey, userPublicKey, transferAmount, poaPrivateKey);
    const { status: txStatus, json: txJson } = await post(baseUrl, "/internal/transaction", tx);
    expect(txStatus).toBe(202);
    expect((txJson as { txId: string }).txId).toBe(tx.id);

    // Mempool should have 1 pending tx
    expect(mempool.size).toBe(1);

    // Produce a block (directly, no need to wait for the polling loop)
    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath);
    expect(block).not.toBeNull();
    expect(block!.index).toBe(1);
    expect(block!.transactions).toHaveLength(1);
    expect(block!.transactions[0].id).toBe(tx.id);

    // Mempool should be drained
    expect(mempool.size).toBe(0);

    // Verify balances via API
    const treasuryEncoded = encodeURIComponent(poaPublicKey);
    const { json: treasuryBalance } = await get(baseUrl, `/internal/balance/${treasuryEncoded}`);
    expect((treasuryBalance as { balance: number }).balance).toBe(10_000_000 - transferAmount);

    const userEncoded = encodeURIComponent(userPublicKey);
    const { json: userBalance } = await get(baseUrl, `/internal/balance/${userEncoded}`);
    expect((userBalance as { balance: number }).balance).toBe(transferAmount);
  });

  it("block is readable via API", async () => {
    const { status, json } = await get(baseUrl, "/internal/block/1");
    expect(status).toBe(200);
    const block = json as { index: number; transactions: { type: string }[] };
    expect(block.index).toBe(1);
    expect(block.transactions[0].type).toBe("Transfer");
  });

  it("rejects duplicate transaction", async () => {
    const tx = buildTransferTx(poaPublicKey, userPublicKey, 50, poaPrivateKey);

    // First submission should succeed
    const { status: s1 } = await post(baseUrl, "/internal/transaction", tx);
    expect(s1).toBe(202);

    // Second submission of same tx should fail
    const { status: s2, json: j2 } = await post(baseUrl, "/internal/transaction", tx);
    expect(s2).toBe(400);
    expect((j2 as { code: string }).code).toBe("DUPLICATE_TX");

    // Clean up: produce the pending block
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath);
  });

  it("rejects transfer with insufficient balance", async () => {
    // User only has 100.5 WPM, try to send 1M
    const userKeys = generateKeyPair();
    const tx = buildTransferTx(userKeys.publicKey, poaPublicKey, 1_000_000, userKeys.privateKey);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INSUFFICIENT_BALANCE");
  });
});
