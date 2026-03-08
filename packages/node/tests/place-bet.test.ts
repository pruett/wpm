import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateKeyPair, sign } from "@wpm/shared";
import type { CreateMarketTx, PlaceBetTx, SharePosition } from "@wpm/shared";
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

function makeCreateMarketTx(
  oraclePublicKey: string,
  oraclePrivateKey: string,
  overrides?: Partial<CreateMarketTx>,
): CreateMarketTx {
  const tx: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oraclePublicKey,
    marketId: randomUUID(),
    sport: "NFL",
    homeTeam: "Chiefs",
    awayTeam: "Eagles",
    outcomeA: "Chiefs Win",
    outcomeB: "Eagles Win",
    eventStartTime: Date.now() + 86_400_000,
    seedAmount: 1000,
    externalEventId: `espn-${randomUUID()}`,
    signature: "",
    ...overrides,
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, oraclePrivateKey);
  return tx;
}

function makePlaceBetTx(
  senderPublicKey: string,
  senderPrivateKey: string,
  marketId: string,
  outcome: "A" | "B",
  amount: number,
  overrides?: Partial<PlaceBetTx>,
): PlaceBetTx {
  const tx: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now(),
    sender: senderPublicKey,
    marketId,
    outcome,
    amount,
    signature: "",
    ...overrides,
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, senderPrivateKey);
  return tx;
}

describe("PlaceBet transaction (FR-8)", () => {
  let tmpDir: string;
  let chainFilePath: string;
  let state: ChainState;
  let mempool: Mempool;
  let api: ReturnType<typeof startApi>;
  let baseUrl: string;

  let poaPublicKey: string;
  let poaPrivateKey: string;
  let oraclePublicKey: string;
  let oraclePrivateKey: string;
  let userPublicKey: string;
  let userPrivateKey: string;
  let marketId: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-place-bet-"));
    chainFilePath = join(tmpDir, "chain.jsonl");

    const poaKeys = generateKeyPair();
    poaPublicKey = poaKeys.publicKey;
    poaPrivateKey = poaKeys.privateKey;

    const oracleKeys = generateKeyPair();
    oraclePublicKey = oracleKeys.publicKey;
    oraclePrivateKey = oracleKeys.privateKey;

    const userKeys = generateKeyPair();
    userPublicKey = userKeys.publicKey;
    userPrivateKey = userKeys.privateKey;

    // Genesis
    const genesis = createGenesisBlock(poaPublicKey, poaPrivateKey);
    state = new ChainState(poaPublicKey);
    appendBlock(genesis, chainFilePath);
    state.applyBlock(genesis);

    mempool = new Mempool(oraclePublicKey);
    api = startApi(state, mempool, { poaPublicKey, poaPrivateKey }, PORT, "127.0.0.1");

    await new Promise<void>((resolve) => {
      if (api.server.listening) return resolve();
      api.server.once("listening", resolve);
    });

    const addr = api.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
    baseUrl = `http://127.0.0.1:${actualPort}`;

    // Create a market (seed 1000)
    const createMarketTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      seedAmount: 1000,
    });
    marketId = createMarketTx.marketId;
    await post(baseUrl, "/internal/transaction", createMarketTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Distribute 10000 WPM to user for betting
    await post(baseUrl, "/internal/distribute", {
      recipient: userPublicKey,
      amount: 10000,
      reason: "signup_airdrop",
    });
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);
  });

  afterAll(async () => {
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("places bet of 100 WPM on outcome A, verifies shares match worked example", async () => {
    const balanceBefore = state.getBalance(userPublicKey);
    const tx = makePlaceBetTx(userPublicKey, userPrivateKey, marketId, "A", 100);

    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(202);
    expect((json as { txId: string }).txId).toBe(tx.id);

    const block = produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
    );
    expect(block).not.toBeNull();
    expect(block!.transactions[0].type).toBe("PlaceBet");

    // Balance should decrease by 100
    expect(state.getBalance(userPublicKey)).toBe(balanceBefore - 100);

    // Verify shares using spec formula: poolA_final = (poolA * poolB) / poolB_afterSwap
    // Starting pool (500, 500), buy 100 A:
    //   fee=1, net=99, mint→(599,599), swap 99B→poolB=698, poolA=358801/698=514.04
    //   additionalA=84.96, sharesToUser=99+84.96=183.96
    // (Spec Example 2 shows 184.53 due to arithmetic rounding error in the doc)
    const position = state.getSharePosition(userPublicKey, marketId, "A");
    expect(position.shares).toBeCloseTo(183.96, 1);
    expect(position.costBasis).toBe(100);

    // Verify pool state:
    // After fee: sharesA=514.04+0.50=514.54, sharesB=698+0.50=698.50
    const { json: marketJson } = await get(
      baseUrl,
      `/internal/market/${encodeURIComponent(marketId)}`,
    );
    const result = marketJson as {
      pool: { sharesA: number; sharesB: number; k: number; wpmLocked: number };
      prices: { priceA: number; priceB: number };
    };
    expect(result.pool.sharesA).toBeCloseTo(514.54, 1);
    expect(result.pool.sharesB).toBeCloseTo(698.5, 1);
    expect(result.pool.wpmLocked).toBe(1100);

    // Verify prices shifted toward A
    expect(result.prices.priceA).toBeCloseTo(0.576, 2);
    expect(result.prices.priceB).toBeCloseTo(0.424, 2);
  });

  it("verifies shares via GET /internal/shares/:address", async () => {
    const { status, json } = await get(
      baseUrl,
      `/internal/shares/${encodeURIComponent(userPublicKey)}`,
    );
    expect(status).toBe(200);
    const result = json as {
      address: string;
      positions: Record<string, Record<string, SharePosition>>;
    };
    expect(result.address).toBe(userPublicKey);
    expect(result.positions[marketId]).toBeDefined();
    expect(result.positions[marketId]["A"].shares).toBeCloseTo(183.96, 1);
    expect(result.positions[marketId]["A"].costBasis).toBe(100);
  });

  it("returns empty positions for address with no shares", async () => {
    const unknownKeys = generateKeyPair();
    const { status, json } = await get(
      baseUrl,
      `/internal/shares/${encodeURIComponent(unknownKeys.publicKey)}`,
    );
    expect(status).toBe(200);
    const result = json as { positions: Record<string, unknown> };
    expect(Object.keys(result.positions)).toHaveLength(0);
  });

  it("rejects bet on non-existent market", async () => {
    const tx = makePlaceBetTx(userPublicKey, userPrivateKey, randomUUID(), "A", 100);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MARKET_NOT_FOUND");
  });

  it("rejects bet below minimum (1.00 WPM)", async () => {
    const tx = makePlaceBetTx(userPublicKey, userPrivateKey, marketId, "A", 0.5);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MINIMUM_BET");
  });

  it("rejects bet with invalid precision", async () => {
    const tx = makePlaceBetTx(userPublicKey, userPrivateKey, marketId, "A", 10.123);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_PRECISION");
  });

  it("rejects bet with insufficient balance", async () => {
    const poorKeys = generateKeyPair();
    const tx = makePlaceBetTx(poorKeys.publicKey, poorKeys.privateKey, marketId, "A", 100);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INSUFFICIENT_BALANCE");
  });

  it("rejects bet with invalid amount (zero)", async () => {
    const tx = makePlaceBetTx(userPublicKey, userPrivateKey, marketId, "A", 0);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_AMOUNT");
  });

  it("accumulates shares from multiple bets on same outcome", async () => {
    const positionBefore = state.getSharePosition(userPublicKey, marketId, "B");

    const tx = makePlaceBetTx(userPublicKey, userPrivateKey, marketId, "B", 50);
    await post(baseUrl, "/internal/transaction", tx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const positionAfter = state.getSharePosition(userPublicKey, marketId, "B");
    expect(positionAfter.shares).toBeGreaterThan(positionBefore.shares);
    expect(positionAfter.costBasis).toBe(positionBefore.costBasis + 50);
  });
});
