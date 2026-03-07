import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateKeyPair, sign, calculateSell } from "@wpm/shared";
import type { CreateMarketTx, PlaceBetTx, SellSharesTx } from "@wpm/shared";
import { createGenesisBlock } from "../src/genesis.js";
import { appendBlock } from "../src/persistence.js";
import { ChainState } from "../src/state.js";
import { Mempool } from "../src/mempool.js";
import { produceBlock } from "../src/producer.js";
import { startApi } from "../src/api.js";

const PORT = 0;

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, senderPrivateKey);
  return tx;
}

function makeSellSharesTx(
  senderPublicKey: string,
  senderPrivateKey: string,
  marketId: string,
  outcome: "A" | "B",
  shareAmount: number,
  overrides?: Partial<SellSharesTx>,
): SellSharesTx {
  const tx: SellSharesTx = {
    id: randomUUID(),
    type: "SellShares",
    timestamp: Date.now(),
    sender: senderPublicKey,
    marketId,
    outcome,
    shareAmount,
    signature: "",
    ...overrides,
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, senderPrivateKey);
  return tx;
}

describe("SellShares transaction (FR-9)", () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-sell-shares-"));
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

    // Place a bet of 100 WPM on outcome A so user has shares to sell
    const betTx = makePlaceBetTx(userPublicKey, userPrivateKey, marketId, "A", 100);
    await post(baseUrl, "/internal/transaction", betTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);
  });

  afterAll(async () => {
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sells shares and receives WPM matching AMM formula", async () => {
    const positionBefore = state.getSharePosition(userPublicKey, marketId, "A");
    const balanceBefore = state.getBalance(userPublicKey);
    const poolBefore = state.pools.get(marketId)!;

    // Sell half the shares
    const sellAmount = Math.floor(positionBefore.shares / 2 * 100) / 100;
    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, marketId, "A", sellAmount);

    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(202);
    expect((json as { txId: string }).txId).toBe(tx.id);

    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);
    expect(block).not.toBeNull();
    expect(block!.transactions[0].type).toBe("SellShares");

    // Verify using calculateSell directly
    const expected = calculateSell(poolBefore, "A", sellAmount);

    // Balance should increase by netReturn
    expect(state.getBalance(userPublicKey)).toBeCloseTo(balanceBefore + expected.netReturn, 2);

    // Shares should decrease
    const positionAfter = state.getSharePosition(userPublicKey, marketId, "A");
    expect(positionAfter.shares).toBeCloseTo(positionBefore.shares - sellAmount, 2);

    // Cost basis reduced proportionally
    const expectedCostBasisReduction = Math.round(positionBefore.costBasis * (sellAmount / positionBefore.shares) * 100) / 100;
    expect(positionAfter.costBasis).toBeCloseTo(positionBefore.costBasis - expectedCostBasisReduction, 2);

    // Pool state matches formula
    const poolAfter = state.pools.get(marketId)!;
    expect(poolAfter.sharesA).toBeCloseTo(expected.pool.sharesA, 2);
    expect(poolAfter.sharesB).toBeCloseTo(expected.pool.sharesB, 2);
    expect(poolAfter.wpmLocked).toBeCloseTo(expected.pool.wpmLocked, 2);
  });

  it("pool k only increases after sell", async () => {
    const poolBefore = state.pools.get(marketId)!;
    const kBefore = poolBefore.k;

    const position = state.getSharePosition(userPublicKey, marketId, "A");
    const sellAmount = Math.min(10, position.shares);
    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, marketId, "A", sellAmount);
    await post(baseUrl, "/internal/transaction", tx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const poolAfter = state.pools.get(marketId)!;
    expect(poolAfter.k).toBeGreaterThanOrEqual(kBefore);
  });

  it("rejects sell on non-existent market", async () => {
    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, randomUUID(), "A", 1);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MARKET_NOT_FOUND");
  });

  it("rejects sell with zero share amount", async () => {
    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, marketId, "A", 0);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_AMOUNT");
  });

  it("rejects sell below minimum (0.01 shares)", async () => {
    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, marketId, "A", 0.001);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MINIMUM_SELL");
  });

  it("rejects sell with insufficient shares", async () => {
    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, marketId, "A", 999999);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INSUFFICIENT_SHARES");
  });

  it("rejects sell on outcome user has no shares in", async () => {
    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, marketId, "B", 1);
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INSUFFICIENT_SHARES");
  });

  it("wpmLocked decreases after sell", async () => {
    const poolBefore = state.pools.get(marketId)!;
    const position = state.getSharePosition(userPublicKey, marketId, "A");
    const sellAmount = Math.min(5, position.shares);

    const tx = makeSellSharesTx(userPublicKey, userPrivateKey, marketId, "A", sellAmount);
    await post(baseUrl, "/internal/transaction", tx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const poolAfter = state.pools.get(marketId)!;
    expect(poolAfter.wpmLocked).toBeLessThan(poolBefore.wpmLocked);
  });
});
