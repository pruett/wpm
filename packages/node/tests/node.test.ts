import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Fiber, Stream, Chunk } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeTestLayer, serveNodeForTest, testKeys, produceBlock } from "./helpers.js";
import { sign, serializeTx, calculatePrices, initializePool, addressOf } from "@wpm/shared";
import { EventBus } from "../src/event-bus.js";

describe("Node", () => {
  it.scoped("multi-user resolution: winners paid, losers zeroed, WPM conserved", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const treasuryAddr = addressOf(testKeys.node.publicKey);
      const user1Addr = addressOf(testKeys.user.publicKey);
      const user2Addr = addressOf(testKeys.user2.publicKey);

      // -- Fund both users --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user1",
        }),
        client.execute,
      );
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user2.publicKey,
          amount: 100_000,
          reason: "fund_user2",
        }),
        client.execute,
      );
      yield* produceBlock;

      // -- Create market (seed 1000) --
      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-multi-1",
          name: "Chiefs vs Eagles",
          outcomes: ["Chiefs", "Eagles"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      // -- user1 bets 100 on A, user2 bets 200 on B --
      const bet1 = {
        type: "PlaceBet" as const,
        marketId: "market-multi-1",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      bet1.signature = sign(serializeTx(bet1), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(bet1),
        client.execute,
      );

      const bet2 = {
        type: "PlaceBet" as const,
        marketId: "market-multi-1",
        outcome: "B" as const,
        amount: 200,
        submitter: testKeys.user2.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      bet2.signature = sign(serializeTx(bet2), testKeys.user2.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(bet2),
        client.execute,
      );
      yield* produceBlock;

      // Capture user1 shares and total WPM before resolution
      const pos1Res = yield* client.get(`/internal/positions/${user1Addr}`);
      const pos1 = (yield* pos1Res.json) as Array<{ shares: number }>;
      const user1Shares = pos1[0].shares;

      // Total minted supply: 10M (genesis) + 100K (user1) + 100K (user2) = 10,200,000
      const totalMinted = 10_000_000 + 100_000 + 100_000;

      // -- Resolve to A (user1 wins) --
      yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-multi-1", result: "A" }),
        client.execute,
      );
      yield* produceBlock;

      // -- Assert: user1 got paid, user2 lost everything --
      const u1Res = yield* client.get(`/internal/balance/${user1Addr}`);
      const { balance: u1Balance } = (yield* u1Res.json) as { balance: number };
      expect(u1Balance).toBe(100_000 - 100 + user1Shares);

      const u2Res = yield* client.get(`/internal/balance/${user2Addr}`);
      const { balance: u2Balance } = (yield* u2Res.json) as { balance: number };
      expect(u2Balance).toBe(100_000 - 200); // lost bet, no payout

      // -- Economic invariant: all WPM accounted for (pool emptied into balances) --
      const tRes = yield* client.get(`/internal/balance/${treasuryAddr}`);
      const { balance: tBalance } = (yield* tRes.json) as { balance: number };
      const totalAfter = tBalance + u1Balance + u2Balance;
      expect(totalAfter).toBe(totalMinted);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("no bets: treasury reclaims full seed on resolution", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const treasuryAddr = addressOf(testKeys.node.publicKey);

      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-nobets",
          name: "No Bets Market",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      const preRes = yield* client.get(`/internal/balance/${treasuryAddr}`);
      const { balance: preTreasury } = (yield* preRes.json) as { balance: number };

      yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-nobets", result: "A" }),
        client.execute,
      );
      yield* produceBlock;

      // Treasury gets full seed back
      const postRes = yield* client.get(`/internal/balance/${treasuryAddr}`);
      const { balance: postTreasury } = (yield* postRes.json) as { balance: number };
      expect(postTreasury).toBe(preTreasury + 1000);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("double resolution rejected", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;

      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-double",
          name: "Double Resolve",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      // First resolution succeeds
      const res1 = yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-double", result: "A" }),
        client.execute,
      );
      expect(res1.status).toBe(200);
      yield* produceBlock;

      // Second resolution rejected
      const res2 = yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-double", result: "B" }),
        client.execute,
      );
      expect(res2.status).toBe(400);
      const body = (yield* res2.json) as { error: { code: string } };
      expect(body.error.code).toBe("MARKET_NOT_OPEN");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("full flow: genesis → fund → market → bet → SSE", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const eventBus = yield* EventBus;

      // -- Genesis: treasury holds initial supply --
      const treasuryRes = yield* client.get(
        `/internal/balance/${addressOf(testKeys.node.publicKey)}`,
      );
      const { balance: treasuryBalance } = (yield* treasuryRes.json) as { balance: number };
      expect(treasuryBalance).toBe(10_000_000);

      // -- Fund user with 100,000 WPM --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user",
        }),
        client.execute,
      );
      yield* produceBlock;

      // -- Create market with 1000 WPM seed --
      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-1",
          name: "Chiefs vs Eagles",
          outcomes: ["Chiefs", "Eagles"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      // Verify market queryable with 50/50 pool
      const mktsRes = yield* client.get("/internal/markets");
      const markets = (yield* mktsRes.json) as Array<{ market: any; pool: any }>;
      expect(markets).toHaveLength(1);
      expect(markets[0].market.name).toBe("Chiefs vs Eagles");
      expect(markets[0].pool.sharesA).toBe(1000);
      expect(markets[0].pool.sharesB).toBe(1000);

      // -- Subscribe to EventBus directly before placing bet --
      const sseStream = yield* eventBus.subscribe;
      const eventFiber = yield* sseStream.pipe(Stream.take(1), Stream.runCollect, Effect.fork);
      yield* Effect.yieldNow();

      // -- Place bet: 100 WPM on outcome A --
      const betTx = {
        type: "PlaceBet" as const,
        marketId: "market-1",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      betTx.signature = sign(serializeTx(betTx), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(betTx),
        client.execute,
      );
      yield* produceBlock;

      // -- Verify odds shifted --
      const mktRes = yield* client.get("/internal/market/market-1");
      const { pool } = (yield* mktRes.json) as { market: any; pool: any };
      const prices = calculatePrices(pool);
      expect(prices.priceA).toBeGreaterThan(0.5);
      expect(prices.priceB).toBeLessThan(0.5);

      // -- Verify balance decreased --
      const userBalRes = yield* client.get(
        `/internal/balance/${addressOf(testKeys.user.publicKey)}`,
      );
      const { balance: userBalance } = (yield* userBalRes.json) as { balance: number };
      expect(userBalance).toBe(100_000 - 100);

      // -- Verify position created --
      const posRes = yield* client.get(`/internal/positions/${addressOf(testKeys.user.publicKey)}`);
      const positions = (yield* posRes.json) as Array<{ outcome: string; shares: number }>;
      expect(positions).toHaveLength(1);
      expect(positions[0].outcome).toBe("A");
      expect(positions[0].shares).toBeGreaterThan(0);

      // -- Verify SSE: trade:executed event received --
      const events = Chunk.toArray(yield* Fiber.join(eventFiber));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("trade:executed");
      expect(events[0].marketId).toBe("market-1");
      expect(events[0].pool.sharesA).not.toBe(events[0].pool.sharesB);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("sell shares: user receives WPM, position reduced, pool shifts back", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const userAddr = addressOf(testKeys.user.publicKey);

      // -- Setup: fund user, create market, buy shares --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user",
        }),
        client.execute,
      );
      yield* produceBlock;

      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-sell-1",
          name: "Sell Test",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      const betTx = {
        type: "PlaceBet" as const,
        marketId: "market-sell-1",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      betTx.signature = sign(serializeTx(betTx), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(betTx),
        client.execute,
      );
      yield* produceBlock;

      // Capture post-buy state
      const postBuyBalRes = yield* client.get(`/internal/balance/${userAddr}`);
      const { balance: postBuyBalance } = (yield* postBuyBalRes.json) as { balance: number };

      const postBuyPosRes = yield* client.get(`/internal/positions/${userAddr}`);
      const postBuyPositions = (yield* postBuyPosRes.json) as Array<{ shares: number }>;
      const totalShares = postBuyPositions[0].shares;

      const postBuyMktRes = yield* client.get("/internal/market/market-sell-1");
      const { pool: postBuyPool } = (yield* postBuyMktRes.json) as { market: any; pool: any };
      const kBefore = postBuyPool.sharesA * postBuyPool.sharesB;

      // -- Action: sell half the shares --
      const halfShares = totalShares / 2;
      const sellTx = {
        type: "SellShares" as const,
        marketId: "market-sell-1",
        outcome: "A" as const,
        shares: halfShares,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      sellTx.signature = sign(serializeTx(sellTx), testKeys.user.privateKey);
      const sellRes = yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(sellTx),
        client.execute,
      );
      expect(sellRes.status).toBe(200);
      yield* produceBlock;

      // -- Assert: balance increased --
      const postSellBalRes = yield* client.get(`/internal/balance/${userAddr}`);
      const { balance: postSellBalance } = (yield* postSellBalRes.json) as { balance: number };
      expect(postSellBalance).toBeGreaterThan(postBuyBalance);

      // -- Assert: position shares reduced by half --
      const postSellPosRes = yield* client.get(`/internal/positions/${userAddr}`);
      const postSellPositions = (yield* postSellPosRes.json) as Array<{ shares: number }>;
      expect(postSellPositions[0].shares).toBeCloseTo(totalShares - halfShares, 6);

      // -- Assert: pool prices shifted back toward 50/50 but not all the way --
      const postSellMktRes = yield* client.get("/internal/market/market-sell-1");
      const { pool: postSellPool } = (yield* postSellMktRes.json) as { market: any; pool: any };
      const pricesAfterSell = calculatePrices(postSellPool);
      expect(pricesAfterSell.priceA).toBeGreaterThan(0.5);
      expect(pricesAfterSell.priceA).toBeLessThan(calculatePrices(postBuyPool).priceA);

      // -- Assert: constant product k preserved --
      const kAfter = postSellPool.sharesA * postSellPool.sharesB;
      expect(kAfter).toBeCloseTo(kBefore, 2);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("sell rejected: insufficient shares", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const userAddr = addressOf(testKeys.user.publicKey);

      // -- Setup --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user",
        }),
        client.execute,
      );
      yield* produceBlock;

      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-sell-insuf",
          name: "Insufficient",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      const betTx = {
        type: "PlaceBet" as const,
        marketId: "market-sell-insuf",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      betTx.signature = sign(serializeTx(betTx), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(betTx),
        client.execute,
      );
      yield* produceBlock;

      // -- Action: try to sell 300 shares (more than owned) --
      const sellTx = {
        type: "SellShares" as const,
        marketId: "market-sell-insuf",
        outcome: "A" as const,
        shares: 300,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      sellTx.signature = sign(serializeTx(sellTx), testKeys.user.privateKey);
      const sellRes = yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(sellTx),
        client.execute,
      );
      expect(sellRes.status).toBe(400);
      const body = (yield* sellRes.json) as { error: { code: string } };
      expect(body.error.code).toBe("INSUFFICIENT_SHARES");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("sell rejected: market not open", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;

      // -- Setup: fund, create, bet, resolve --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user",
        }),
        client.execute,
      );
      yield* produceBlock;

      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-sell-closed",
          name: "Closed Market",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      const betTx = {
        type: "PlaceBet" as const,
        marketId: "market-sell-closed",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      betTx.signature = sign(serializeTx(betTx), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(betTx),
        client.execute,
      );
      yield* produceBlock;

      // Resolve market
      yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-sell-closed", result: "A" }),
        client.execute,
      );
      yield* produceBlock;

      // -- Action: try to sell after resolution --
      const sellTx = {
        type: "SellShares" as const,
        marketId: "market-sell-closed",
        outcome: "A" as const,
        shares: 10,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      sellTx.signature = sign(serializeTx(sellTx), testKeys.user.privateKey);
      const sellRes = yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(sellTx),
        client.execute,
      );
      expect(sellRes.status).toBe(400);
      const body = (yield* sellRes.json) as { error: { code: string } };
      expect(body.error.code).toBe("MARKET_CLOSED");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("buy-sell-buy sequence: AMM invariants hold across mixed trades", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const userAddr = addressOf(testKeys.user.publicKey);

      // -- Setup --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user",
        }),
        client.execute,
      );
      yield* produceBlock;

      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-mixed",
          name: "Mixed Trades",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      const initialPool = initializePool("market-mixed", 1000);
      const k = initialPool.k;

      // -- Buy A --
      const bet1 = {
        type: "PlaceBet" as const,
        marketId: "market-mixed",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      bet1.signature = sign(serializeTx(bet1), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(bet1),
        client.execute,
      );
      yield* produceBlock;

      // Check invariants after buy A
      const mkt1Res = yield* client.get("/internal/market/market-mixed");
      const { pool: pool1 } = (yield* mkt1Res.json) as { market: any; pool: any };
      const prices1 = calculatePrices(pool1);
      expect(prices1.priceA + prices1.priceB).toBeCloseTo(1.0, 10);
      expect(pool1.sharesA * pool1.sharesB).toBeCloseTo(k, 2);

      // -- Sell half of A --
      const pos1Res = yield* client.get(`/internal/positions/${userAddr}`);
      const pos1 = (yield* pos1Res.json) as Array<{ shares: number; outcome: string }>;
      const aShares = pos1.find((p) => p.outcome === "A")!.shares;

      const sell1 = {
        type: "SellShares" as const,
        marketId: "market-mixed",
        outcome: "A" as const,
        shares: aShares / 2,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      sell1.signature = sign(serializeTx(sell1), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(sell1),
        client.execute,
      );
      yield* produceBlock;

      // Check invariants after sell
      const mkt2Res = yield* client.get("/internal/market/market-mixed");
      const { pool: pool2 } = (yield* mkt2Res.json) as { market: any; pool: any };
      const prices2 = calculatePrices(pool2);
      expect(prices2.priceA + prices2.priceB).toBeCloseTo(1.0, 10);
      expect(pool2.sharesA * pool2.sharesB).toBeCloseTo(k, 2);

      // -- Buy B --
      const bet2 = {
        type: "PlaceBet" as const,
        marketId: "market-mixed",
        outcome: "B" as const,
        amount: 50,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      bet2.signature = sign(serializeTx(bet2), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(bet2),
        client.execute,
      );
      yield* produceBlock;

      // Check invariants after buy B
      const mkt3Res = yield* client.get("/internal/market/market-mixed");
      const { pool: pool3 } = (yield* mkt3Res.json) as { market: any; pool: any };
      const prices3 = calculatePrices(pool3);
      expect(prices3.priceA + prices3.priceB).toBeCloseTo(1.0, 10);
      expect(pool3.sharesA * pool3.sharesB).toBeCloseTo(k, 2);
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("multi-user buy-sell-resolve: WPM conservation", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const treasuryAddr = addressOf(testKeys.node.publicKey);
      const user1Addr = addressOf(testKeys.user.publicKey);
      const user2Addr = addressOf(testKeys.user2.publicKey);

      // -- Fund both users --
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user.publicKey,
          amount: 100_000,
          reason: "fund_user1",
        }),
        client.execute,
      );
      yield* HttpClientRequest.post("/internal/distribute").pipe(
        HttpClientRequest.bodyUnsafeJson({
          recipient: testKeys.user2.publicKey,
          amount: 100_000,
          reason: "fund_user2",
        }),
        client.execute,
      );
      yield* produceBlock;

      // -- Create market --
      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-conserve",
          name: "Conservation",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      // User1 buys A
      const bet1 = {
        type: "PlaceBet" as const,
        marketId: "market-conserve",
        outcome: "A" as const,
        amount: 100,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      bet1.signature = sign(serializeTx(bet1), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(bet1),
        client.execute,
      );
      yield* produceBlock;

      // User2 buys B
      const bet2 = {
        type: "PlaceBet" as const,
        marketId: "market-conserve",
        outcome: "B" as const,
        amount: 200,
        submitter: testKeys.user2.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      bet2.signature = sign(serializeTx(bet2), testKeys.user2.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(bet2),
        client.execute,
      );
      yield* produceBlock;

      // User1 sells half of A
      const pos1Res = yield* client.get(`/internal/positions/${user1Addr}`);
      const pos1 = (yield* pos1Res.json) as Array<{ shares: number }>;
      const halfA = pos1[0].shares / 2;

      const sell1 = {
        type: "SellShares" as const,
        marketId: "market-conserve",
        outcome: "A" as const,
        shares: halfA,
        submitter: testKeys.user.publicKey,
        timestamp: new Date().toISOString(),
        signature: "",
      };
      sell1.signature = sign(serializeTx(sell1), testKeys.user.privateKey);
      yield* HttpClientRequest.post("/internal/transaction").pipe(
        HttpClientRequest.bodyUnsafeJson(sell1),
        client.execute,
      );
      yield* produceBlock;

      // Resolve to B
      yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-conserve", result: "B" }),
        client.execute,
      );
      yield* produceBlock;

      // -- Assert: total WPM conserved --
      const totalMinted = 10_000_000 + 100_000 + 100_000;
      const u1Res = yield* client.get(`/internal/balance/${user1Addr}`);
      const { balance: u1Balance } = (yield* u1Res.json) as { balance: number };
      const u2Res = yield* client.get(`/internal/balance/${user2Addr}`);
      const { balance: u2Balance } = (yield* u2Res.json) as { balance: number };
      const tRes = yield* client.get(`/internal/balance/${treasuryAddr}`);
      const { balance: tBalance } = (yield* tRes.json) as { balance: number };

      expect(tBalance + u1Balance + u2Balance).toBeCloseTo(totalMinted, 0);
    }).pipe(Effect.provide(NodeTestLayer)),
  );
});
