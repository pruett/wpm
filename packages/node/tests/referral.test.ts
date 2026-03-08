import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, sign } from "@wpm/shared";
import { randomUUID } from "node:crypto";
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

describe("Referral transaction (FR-13)", () => {
  let tmpDir: string;
  let chainFilePath: string;
  let state: ChainState;
  let mempool: Mempool;
  let api: ReturnType<typeof startApi>;
  let baseUrl: string;

  let poaPublicKey: string;
  let poaPrivateKey: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-referral-"));
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

  it("submits referral reward and verifies 5000 WPM transferred", async () => {
    const inviter = generateKeyPair();
    const referredUser = generateKeyPair();

    const { status, json } = await post(baseUrl, "/internal/referral-reward", {
      inviterAddress: inviter.publicKey,
      referredUser: referredUser.publicKey,
    });
    expect(status).toBe(202);
    expect((json as { txId: string }).txId).toBeDefined();

    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath);
    expect(block).not.toBeNull();
    expect(block!.transactions).toHaveLength(1);
    expect(block!.transactions[0].type).toBe("Referral");

    const encodedInviter = encodeURIComponent(inviter.publicKey);
    const { json: balJson } = await get(baseUrl, `/internal/balance/${encodedInviter}`);
    expect((balJson as { balance: number }).balance).toBe(5000);

    const encodedTreasury = encodeURIComponent(poaPublicKey);
    const { json: treasuryJson } = await get(baseUrl, `/internal/balance/${encodedTreasury}`);
    expect((treasuryJson as { balance: number }).balance).toBe(10_000_000 - 5000);
  });

  it("rejects duplicate referral for the same referred user", async () => {
    const inviter = generateKeyPair();
    const referredUser = generateKeyPair();

    // First referral succeeds
    const { status: s1 } = await post(baseUrl, "/internal/referral-reward", {
      inviterAddress: inviter.publicKey,
      referredUser: referredUser.publicKey,
    });
    expect(s1).toBe(202);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath);

    // Duplicate referral rejected
    const { status, json } = await post(baseUrl, "/internal/referral-reward", {
      inviterAddress: inviter.publicKey,
      referredUser: referredUser.publicKey,
    });
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("DUPLICATE_REFERRAL");
  });

  it("rejects Referral submitted via POST /internal/transaction", async () => {
    const inviter = generateKeyPair();
    const referredUser = generateKeyPair();

    const tx = {
      id: randomUUID(),
      type: "Referral",
      timestamp: Date.now(),
      sender: poaPublicKey,
      recipient: inviter.publicKey,
      amount: 5000,
      referredUser: referredUser.publicKey,
      signature: "",
    };
    const signData = JSON.stringify({ ...tx, signature: undefined });
    tx.signature = sign(signData, poaPrivateKey);

    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("SYSTEM_TX_ONLY");
  });

  it("rejects referral when treasury has insufficient balance", async () => {
    // Create a state with nearly empty treasury to test
    const tmpDir2 = mkdtempSync(join(tmpdir(), "wpm-referral-insuf-"));
    const chainFile2 = join(tmpDir2, "chain.jsonl");
    const keys2 = generateKeyPair();
    const genesis2 = createGenesisBlock(keys2.publicKey, keys2.privateKey);
    const state2 = new ChainState(keys2.publicKey);
    appendBlock(genesis2, chainFile2);
    state2.applyBlock(genesis2);

    // Drain treasury to near zero
    state2.setBalance(keys2.publicKey, 100);

    const mempool2 = new Mempool();
    const api2 = startApi(
      state2,
      mempool2,
      { poaPublicKey: keys2.publicKey, poaPrivateKey: keys2.privateKey },
      0,
      "127.0.0.1",
    );
    await new Promise<void>((resolve) => {
      if (api2.server.listening) return resolve();
      api2.server.once("listening", resolve);
    });
    const addr2 = api2.server.address();
    const port2 = typeof addr2 === "object" && addr2 ? addr2.port : 0;
    const base2 = `http://127.0.0.1:${port2}`;

    const inviter = generateKeyPair();
    const referredUser = generateKeyPair();
    const { status, json } = await post(base2, "/internal/referral-reward", {
      inviterAddress: inviter.publicKey,
      referredUser: referredUser.publicKey,
    });
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INSUFFICIENT_TREASURY");

    await api2.close();
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("tracks referredUser in state after block production", async () => {
    const inviter = generateKeyPair();
    const referredUser = generateKeyPair();

    await post(baseUrl, "/internal/referral-reward", {
      inviterAddress: inviter.publicKey,
      referredUser: referredUser.publicKey,
    });
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath);

    expect(state.referredUsers.has(referredUser.publicKey)).toBe(true);
  });
});
