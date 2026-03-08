import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair } from "@wpm/shared";
import { createGenesisBlock } from "../src/genesis.js";
import { appendBlock } from "../src/persistence.js";
import { ChainState } from "../src/state.js";
import { Mempool } from "../src/mempool.js";
import { produceBlock } from "../src/producer.js";
import { startApi } from "../src/api.js";

const PORT = 0;

async function post(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
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

describe("Distribute transaction (FR-6)", () => {
  let tmpDir: string;
  let chainFilePath: string;
  let state: ChainState;
  let mempool: Mempool;
  let api: ReturnType<typeof startApi>;
  let baseUrl: string;

  let poaPublicKey: string;
  let poaPrivateKey: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-distribute-"));
    chainFilePath = join(tmpDir, "chain.jsonl");

    const poaKeys = generateKeyPair();
    poaPublicKey = poaKeys.publicKey;
    poaPrivateKey = poaKeys.privateKey;

    const genesis = createGenesisBlock(poaPublicKey, poaPrivateKey);
    state = new ChainState(poaPublicKey);
    appendBlock(genesis, chainFilePath);
    state.applyBlock(genesis);

    mempool = new Mempool();
    api = startApi(state, mempool, { poaPublicKey, poaPrivateKey }, PORT, "127.0.0.1");

    await new Promise<void>((resolve) => {
      if (api.server.listening) return resolve();
      api.server.once("listening", resolve);
    });

    const addr = api.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
    baseUrl = `http://127.0.0.1:${actualPort}`;
  });

  afterAll(async () => {
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("distributes from treasury to recipient, verify balance", async () => {
    const userKeys = generateKeyPair();
    const recipient = userKeys.publicKey;
    const amount = 1000;

    const { status, json } = await post(baseUrl, "/internal/distribute", {
      recipient,
      amount,
      reason: "signup_airdrop",
    });
    expect(status).toBe(202);
    expect((json as { txId: string }).txId).toBeDefined();

    // Produce the block
    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath);
    expect(block).not.toBeNull();
    expect(block!.transactions).toHaveLength(1);
    expect(block!.transactions[0].type).toBe("Distribute");

    // Verify recipient balance
    const encodedRecipient = encodeURIComponent(recipient);
    const { json: balJson } = await get(baseUrl, `/internal/balance/${encodedRecipient}`);
    expect((balJson as { balance: number }).balance).toBe(amount);

    // Verify treasury decreased
    const encodedTreasury = encodeURIComponent(poaPublicKey);
    const { json: treasuryJson } = await get(baseUrl, `/internal/balance/${encodedTreasury}`);
    expect((treasuryJson as { balance: number }).balance).toBe(10_000_000 - amount);
  });

  it("rejects distribute with invalid reason", async () => {
    const userKeys = generateKeyPair();
    const { status, json } = await post(baseUrl, "/internal/distribute", {
      recipient: userKeys.publicKey,
      amount: 100,
      reason: "free_money",
    });
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_REASON");
  });

  it("rejects distribute with invalid amount", async () => {
    const userKeys = generateKeyPair();
    const { status, json } = await post(baseUrl, "/internal/distribute", {
      recipient: userKeys.publicKey,
      amount: 0,
      reason: "manual",
    });
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_AMOUNT");
  });

  it("rejects distribute with bad precision", async () => {
    const userKeys = generateKeyPair();
    const { status, json } = await post(baseUrl, "/internal/distribute", {
      recipient: userKeys.publicKey,
      amount: 10.123,
      reason: "manual",
    });
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_PRECISION");
  });

  it("rejects distribute exceeding treasury balance", async () => {
    const userKeys = generateKeyPair();
    const { status, json } = await post(baseUrl, "/internal/distribute", {
      recipient: userKeys.publicKey,
      amount: 999_999_999,
      reason: "manual",
    });
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INSUFFICIENT_TREASURY");
  });

  it("accepts all valid reason types", async () => {
    for (const reason of ["signup_airdrop", "referral_reward", "manual"]) {
      const userKeys = generateKeyPair();
      const { status } = await post(baseUrl, "/internal/distribute", {
        recipient: userKeys.publicKey,
        amount: 10,
        reason,
      });
      expect(status).toBe(202);
    }
    // Drain mempool
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath);
  });
});
