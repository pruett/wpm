import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateKeyPair, sign } from "@wpm/shared";
import type { CreateMarketTx, PlaceBetTx, ResolveMarketTx, SettlePayoutTx } from "@wpm/shared";
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
    eventStartTime: Date.now() + 2_000,
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

function makeResolveMarketTx(
  oraclePublicKey: string,
  oraclePrivateKey: string,
  marketId: string,
  winningOutcome: "A" | "B",
  overrides?: Partial<ResolveMarketTx>,
): ResolveMarketTx {
  const tx: ResolveMarketTx = {
    id: randomUUID(),
    type: "ResolveMarket",
    // Timestamp must be >= eventStartTime (2s in future) and within 300s mempool drift
    timestamp: Date.now() + 3_000,
    sender: oraclePublicKey,
    marketId,
    winningOutcome,
    finalScore: "Chiefs 27, Eagles 24",
    signature: "",
    ...overrides,
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, oraclePrivateKey);
  return tx;
}

describe("ResolveMarket & SettlePayout (FR-10, FR-12)", () => {
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
  let user1PublicKey: string;
  let user1PrivateKey: string;
  let user2PublicKey: string;
  let user2PrivateKey: string;
  let marketId: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-resolve-"));
    chainFilePath = join(tmpDir, "chain.jsonl");

    const poaKeys = generateKeyPair();
    poaPublicKey = poaKeys.publicKey;
    poaPrivateKey = poaKeys.privateKey;

    const oracleKeys = generateKeyPair();
    oraclePublicKey = oracleKeys.publicKey;
    oraclePrivateKey = oracleKeys.privateKey;

    const user1Keys = generateKeyPair();
    user1PublicKey = user1Keys.publicKey;
    user1PrivateKey = user1Keys.privateKey;

    const user2Keys = generateKeyPair();
    user2PublicKey = user2Keys.publicKey;
    user2PrivateKey = user2Keys.privateKey;

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

    // Distribute WPM to users for betting
    await post(baseUrl, "/internal/distribute", {
      recipient: user1PublicKey,
      amount: 10000,
      reason: "signup_airdrop",
    });
    await post(baseUrl, "/internal/distribute", {
      recipient: user2PublicKey,
      amount: 10000,
      reason: "signup_airdrop",
    });
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // User1 bets 100 WPM on outcome A, User2 bets 50 WPM on outcome B
    const bet1 = makePlaceBetTx(user1PublicKey, user1PrivateKey, marketId, "A", 100);
    await post(baseUrl, "/internal/transaction", bet1);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const bet2 = makePlaceBetTx(user2PublicKey, user2PrivateKey, marketId, "B", 50);
    await post(baseUrl, "/internal/transaction", bet2);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);
  });

  afterAll(async () => {
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves market with correct payouts and conservation", async () => {
    const poolBefore = state.pools.get(marketId)!;
    const wpmLockedBefore = poolBefore.wpmLocked;
    const user1SharesBefore = state.getSharePosition(user1PublicKey, marketId, "A").shares;
    const user1BalanceBefore = state.getBalance(user1PublicKey);
    const user2BalanceBefore = state.getBalance(user2PublicKey);

    // Resolve market — outcome A wins
    const resolveTx = makeResolveMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "A");
    await post(baseUrl, "/internal/transaction", resolveTx);
    const block = produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
    );

    expect(block).not.toBeNull();

    // Block should contain ResolveMarket + SettlePayout txs
    expect(block!.transactions[0].type).toBe("ResolveMarket");
    const settlePayouts = block!.transactions.filter(
      (tx) => tx.type === "SettlePayout",
    ) as SettlePayoutTx[];
    expect(settlePayouts.length).toBeGreaterThanOrEqual(1);

    // User1 should receive winningShares * 1.00
    const user1Payout = settlePayouts.find((p) => p.recipient === user1PublicKey);
    expect(user1Payout).toBeDefined();
    expect(user1Payout!.amount).toBeCloseTo(user1SharesBefore * 1.0, 2);
    expect(user1Payout!.payoutType).toBe("winnings");

    // User2 had outcome B — no payout
    const user2Payout = settlePayouts.find((p) => p.recipient === user2PublicKey);
    expect(user2Payout).toBeUndefined();

    // Balances updated correctly
    expect(state.getBalance(user1PublicKey)).toBeCloseTo(
      user1BalanceBefore + user1Payout!.amount,
      2,
    );
    expect(state.getBalance(user2PublicKey)).toBe(user2BalanceBefore);

    // Treasury gets liquidity return (remainder)
    const treasuryPayout = settlePayouts.find((p) => p.payoutType === "liquidity_return");
    expect(treasuryPayout).toBeDefined();

    // Conservation: sum of all payouts === wpmLocked
    const totalPayouts = settlePayouts.reduce((sum, p) => sum + p.amount, 0);
    expect(totalPayouts).toBeCloseTo(wpmLockedBefore, 2);

    // Market status is resolved
    const market = state.markets.get(marketId)!;
    expect(market.status).toBe("resolved");
    expect(market.winningOutcome).toBe("A");

    // Pool and positions are cleaned up
    expect(state.pools.has(marketId)).toBe(false);
    for (const [, byMarket] of state.sharePositions) {
      expect(byMarket.has(marketId)).toBe(false);
    }
  });

  it("rejects SettlePayout submitted via API", async () => {
    const tx: SettlePayoutTx = {
      id: randomUUID(),
      type: "SettlePayout",
      timestamp: Date.now(),
      sender: poaPublicKey,
      marketId,
      recipient: user1PublicKey,
      amount: 100,
      payoutType: "winnings",
      signature: "",
    };
    const signData = JSON.stringify({ ...tx, signature: undefined });
    tx.signature = sign(signData, poaPrivateKey);

    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("SYSTEM_TX_ONLY");
  });

  it("rejects resolve from non-oracle sender", async () => {
    // Create a fresh market for this test
    const newMarketTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey);
    await post(baseUrl, "/internal/transaction", newMarketTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const tx = makeResolveMarketTx(user1PublicKey, user1PrivateKey, newMarketTx.marketId, "A");
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("UNAUTHORIZED_ORACLE");
  });

  it("rejects resolve for non-existent market", async () => {
    const tx = makeResolveMarketTx(oraclePublicKey, oraclePrivateKey, randomUUID(), "A");
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MARKET_NOT_FOUND");
  });

  it("rejects resolve for already resolved market", async () => {
    // marketId was already resolved in the first test
    const tx = makeResolveMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "A");
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MARKET_NOT_OPEN");
  });

  it("rejects resolve before event start time", async () => {
    const newMarketTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey);
    await post(baseUrl, "/internal/transaction", newMarketTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Timestamp is before eventStartTime
    const tx = makeResolveMarketTx(oraclePublicKey, oraclePrivateKey, newMarketTx.marketId, "A", {
      timestamp: Date.now(),
    });
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("EVENT_NOT_STARTED");
  });

  it("resolves zero-bet market with full seed return to treasury", async () => {
    const newMarketTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      seedAmount: 500,
    });
    await post(baseUrl, "/internal/transaction", newMarketTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const treasuryBefore = state.getBalance(poaPublicKey);

    const resolveTx = makeResolveMarketTx(
      oraclePublicKey,
      oraclePrivateKey,
      newMarketTx.marketId,
      "A",
    );
    await post(baseUrl, "/internal/transaction", resolveTx);
    const block = produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
    );

    expect(block).not.toBeNull();
    const settlePayouts = block!.transactions.filter(
      (tx) => tx.type === "SettlePayout",
    ) as SettlePayoutTx[];

    // Only treasury gets the payout
    expect(settlePayouts.length).toBe(1);
    expect(settlePayouts[0].recipient).toBe(poaPublicKey);
    expect(settlePayouts[0].payoutType).toBe("liquidity_return");
    expect(settlePayouts[0].amount).toBe(500);

    // Treasury balance increases by seed amount
    expect(state.getBalance(poaPublicKey)).toBeCloseTo(treasuryBefore + 500, 2);
  });

  it("SettlePayout transactions are ordered: user payouts sorted by address, treasury last", async () => {
    // Create market, have multiple users bet, resolve
    const newMarketTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      seedAmount: 1000,
    });
    await post(baseUrl, "/internal/transaction", newMarketTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Both users bet on outcome A (both will win)
    const bet1 = makePlaceBetTx(user1PublicKey, user1PrivateKey, newMarketTx.marketId, "A", 50);
    await post(baseUrl, "/internal/transaction", bet1);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const bet2 = makePlaceBetTx(user2PublicKey, user2PrivateKey, newMarketTx.marketId, "A", 30);
    await post(baseUrl, "/internal/transaction", bet2);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const resolveTx = makeResolveMarketTx(
      oraclePublicKey,
      oraclePrivateKey,
      newMarketTx.marketId,
      "A",
    );
    await post(baseUrl, "/internal/transaction", resolveTx);
    const block = produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
    );

    const settlePayouts = block!.transactions.filter(
      (tx) => tx.type === "SettlePayout",
    ) as SettlePayoutTx[];

    // Last payout should be treasury (liquidity_return)
    const lastPayout = settlePayouts[settlePayouts.length - 1];
    expect(lastPayout.payoutType).toBe("liquidity_return");
    expect(lastPayout.recipient).toBe(poaPublicKey);

    // User payouts (all except last) should be sorted by recipient address
    const userPayouts = settlePayouts.slice(0, -1);
    for (let i = 1; i < userPayouts.length; i++) {
      expect(
        userPayouts[i].recipient.localeCompare(userPayouts[i - 1].recipient),
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
