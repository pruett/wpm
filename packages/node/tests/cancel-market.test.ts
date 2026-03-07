import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateKeyPair, sign } from "@wpm/shared";
import type { CreateMarketTx, PlaceBetTx, CancelMarketTx, SellSharesTx, SettlePayoutTx } from "@wpm/shared";
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

function makeSellSharesTx(
  senderPublicKey: string,
  senderPrivateKey: string,
  marketId: string,
  outcome: "A" | "B",
  shareAmount: number,
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
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, senderPrivateKey);
  return tx;
}

function makeCancelMarketTx(
  senderPublicKey: string,
  senderPrivateKey: string,
  marketId: string,
  reason: string,
  overrides?: Partial<CancelMarketTx>,
): CancelMarketTx {
  const tx: CancelMarketTx = {
    id: randomUUID(),
    type: "CancelMarket",
    timestamp: Date.now(),
    sender: senderPublicKey,
    marketId,
    reason,
    signature: "",
    ...overrides,
  };
  const signData = JSON.stringify({ ...tx, signature: undefined });
  tx.signature = sign(signData, senderPrivateKey);
  return tx;
}

describe("CancelMarket (FR-11)", () => {
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

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-cancel-"));
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

    // Distribute WPM to users
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
  });

  afterAll(async () => {
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cancels market with correct refunds and conservation", async () => {
    // Create market
    const createTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, { seedAmount: 1000 });
    const marketId = createTx.marketId;
    await post(baseUrl, "/internal/transaction", createTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // User1 bets 100 WPM on A, User2 bets 50 WPM on B
    const bet1 = makePlaceBetTx(user1PublicKey, user1PrivateKey, marketId, "A", 100);
    await post(baseUrl, "/internal/transaction", bet1);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const bet2 = makePlaceBetTx(user2PublicKey, user2PrivateKey, marketId, "B", 50);
    await post(baseUrl, "/internal/transaction", bet2);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const poolBefore = state.pools.get(marketId)!;
    const wpmLockedBefore = poolBefore.wpmLocked;
    const user1CostBasis = state.getSharePosition(user1PublicKey, marketId, "A").costBasis;
    const user2CostBasis = state.getSharePosition(user2PublicKey, marketId, "B").costBasis;
    const user1BalanceBefore = state.getBalance(user1PublicKey);
    const user2BalanceBefore = state.getBalance(user2PublicKey);

    // Cancel market (oracle sender)
    const cancelTx = makeCancelMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "Game postponed");
    await post(baseUrl, "/internal/transaction", cancelTx);
    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    expect(block).not.toBeNull();
    expect(block!.transactions[0].type).toBe("CancelMarket");

    const settlePayouts = block!.transactions.filter((tx) => tx.type === "SettlePayout") as SettlePayoutTx[];
    expect(settlePayouts.length).toBeGreaterThanOrEqual(2); // at least user refunds + treasury

    // User1 refunded their cost basis
    const user1Payout = settlePayouts.find((p) => p.recipient === user1PublicKey);
    expect(user1Payout).toBeDefined();
    expect(user1Payout!.amount).toBeCloseTo(user1CostBasis, 2);
    expect(user1Payout!.payoutType).toBe("refund");

    // User2 refunded their cost basis
    const user2Payout = settlePayouts.find((p) => p.recipient === user2PublicKey);
    expect(user2Payout).toBeDefined();
    expect(user2Payout!.amount).toBeCloseTo(user2CostBasis, 2);
    expect(user2Payout!.payoutType).toBe("refund");

    // Balances updated
    expect(state.getBalance(user1PublicKey)).toBeCloseTo(user1BalanceBefore + user1CostBasis, 2);
    expect(state.getBalance(user2PublicKey)).toBeCloseTo(user2BalanceBefore + user2CostBasis, 2);

    // Treasury gets liquidity return
    const treasuryPayout = settlePayouts.find((p) => p.payoutType === "liquidity_return");
    expect(treasuryPayout).toBeDefined();

    // Conservation: sum of all payouts === wpmLocked
    const totalPayouts = settlePayouts.reduce((sum, p) => sum + p.amount, 0);
    expect(totalPayouts).toBeCloseTo(wpmLockedBefore, 2);

    // Market status is cancelled
    const market = state.markets.get(marketId)!;
    expect(market.status).toBe("cancelled");

    // Pool and positions cleaned up
    expect(state.pools.has(marketId)).toBe(false);
    for (const [, byMarket] of state.sharePositions) {
      expect(byMarket.has(marketId)).toBe(false);
    }
  });

  it("refunds net cost basis after partial sell", async () => {
    // Create market
    const createTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, { seedAmount: 1000 });
    const marketId = createTx.marketId;
    await post(baseUrl, "/internal/transaction", createTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // User1 bets 100 WPM on A
    const bet = makePlaceBetTx(user1PublicKey, user1PrivateKey, marketId, "A", 100);
    await post(baseUrl, "/internal/transaction", bet);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // User1 sells some shares
    const position = state.getSharePosition(user1PublicKey, marketId, "A");
    const sellAmount = Math.floor(position.shares * 0.5 * 100) / 100; // sell ~half
    const sellTx = makeSellSharesTx(user1PublicKey, user1PrivateKey, marketId, "A", sellAmount);
    await post(baseUrl, "/internal/transaction", sellTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const costBasisAfterSell = state.getSharePosition(user1PublicKey, marketId, "A").costBasis;
    const user1BalanceBefore = state.getBalance(user1PublicKey);

    // Cancel market
    const cancelTx = makeCancelMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "Game cancelled");
    await post(baseUrl, "/internal/transaction", cancelTx);
    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const settlePayouts = block!.transactions.filter((tx) => tx.type === "SettlePayout") as SettlePayoutTx[];
    const user1Payout = settlePayouts.find((p) => p.recipient === user1PublicKey);
    expect(user1Payout).toBeDefined();
    // Refund should match the reduced cost basis (not the original 100)
    expect(user1Payout!.amount).toBeCloseTo(costBasisAfterSell, 2);
    expect(user1Payout!.amount).toBeLessThan(100);

    // Balance increased by cost basis
    expect(state.getBalance(user1PublicKey)).toBeCloseTo(user1BalanceBefore + costBasisAfterSell, 2);
  });

  it("cancels zero-bet market with full seed return to treasury", async () => {
    const createTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, { seedAmount: 500 });
    const marketId = createTx.marketId;
    await post(baseUrl, "/internal/transaction", createTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const treasuryBefore = state.getBalance(poaPublicKey);

    const cancelTx = makeCancelMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "Game ended in a tie");
    await post(baseUrl, "/internal/transaction", cancelTx);
    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    expect(block).not.toBeNull();
    const settlePayouts = block!.transactions.filter((tx) => tx.type === "SettlePayout") as SettlePayoutTx[];

    // Only treasury payout
    expect(settlePayouts.length).toBe(1);
    expect(settlePayouts[0].recipient).toBe(poaPublicKey);
    expect(settlePayouts[0].payoutType).toBe("liquidity_return");
    expect(settlePayouts[0].amount).toBe(500);

    expect(state.getBalance(poaPublicKey)).toBeCloseTo(treasuryBefore + 500, 2);
  });

  it("allows PoA signer (admin) to cancel a market", async () => {
    const createTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, { seedAmount: 500 });
    const marketId = createTx.marketId;
    await post(baseUrl, "/internal/transaction", createTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Cancel with PoA key (admin)
    const cancelTx = makeCancelMarketTx(poaPublicKey, poaPrivateKey, marketId, "Admin cancellation");
    await post(baseUrl, "/internal/transaction", cancelTx);
    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    expect(block).not.toBeNull();
    expect(block!.transactions[0].type).toBe("CancelMarket");
    expect(state.markets.get(marketId)!.status).toBe("cancelled");
  });

  it("rejects cancel from unauthorized sender", async () => {
    const createTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey);
    await post(baseUrl, "/internal/transaction", createTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const cancelTx = makeCancelMarketTx(user1PublicKey, user1PrivateKey, createTx.marketId, "Unauthorized");
    const { status, json } = await post(baseUrl, "/internal/transaction", cancelTx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("UNAUTHORIZED_SENDER");
  });

  it("rejects cancel for non-existent market", async () => {
    const cancelTx = makeCancelMarketTx(oraclePublicKey, oraclePrivateKey, randomUUID(), "Not found");
    const { status, json } = await post(baseUrl, "/internal/transaction", cancelTx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MARKET_NOT_FOUND");
  });

  it("rejects cancel for already cancelled market", async () => {
    const createTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, { seedAmount: 500 });
    const marketId = createTx.marketId;
    await post(baseUrl, "/internal/transaction", createTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Cancel once
    const cancel1 = makeCancelMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "First cancel");
    await post(baseUrl, "/internal/transaction", cancel1);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Try cancel again
    const cancel2 = makeCancelMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "Second cancel");
    const { status, json } = await post(baseUrl, "/internal/transaction", cancel2);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MARKET_NOT_OPEN");
  });

  it("conservation holds across multiple users with different outcomes", async () => {
    const createTx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, { seedAmount: 2000 });
    const marketId = createTx.marketId;
    await post(baseUrl, "/internal/transaction", createTx);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // User1 bets on A, User2 bets on B
    const bet1 = makePlaceBetTx(user1PublicKey, user1PrivateKey, marketId, "A", 200);
    await post(baseUrl, "/internal/transaction", bet1);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const bet2 = makePlaceBetTx(user2PublicKey, user2PrivateKey, marketId, "B", 150);
    await post(baseUrl, "/internal/transaction", bet2);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Another bet from user1 on B
    const bet3 = makePlaceBetTx(user1PublicKey, user1PrivateKey, marketId, "B", 75);
    await post(baseUrl, "/internal/transaction", bet3);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const poolBefore = state.pools.get(marketId)!;
    const wpmLockedBefore = poolBefore.wpmLocked;

    const cancelTx = makeCancelMarketTx(oraclePublicKey, oraclePrivateKey, marketId, "Game ended in a tie");
    await post(baseUrl, "/internal/transaction", cancelTx);
    const block = produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const settlePayouts = block!.transactions.filter((tx) => tx.type === "SettlePayout") as SettlePayoutTx[];
    const totalPayouts = settlePayouts.reduce((sum, p) => sum + p.amount, 0);
    expect(totalPayouts).toBeCloseTo(wpmLockedBefore, 2);
  });
});
