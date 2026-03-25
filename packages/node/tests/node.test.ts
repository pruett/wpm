import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Fiber, Stream, Chunk } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeTestLayer, serveNodeForTest, testKeys, produceBlock } from "./helpers.js";
import { sign, serializeTx, calculatePrices, addressOf } from "@wpm/shared";
import { EventBus } from "../src/event-bus.js";

describe("Node", () => {
  it.scoped("resolve market: status transitions to resolved with result", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;

      // -- Setup: fund user, create market, place bet --
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
          id: "market-resolve-1",
          name: "Chiefs vs Eagles",
          outcomes: ["Chiefs", "Eagles"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      // Place a bet so there's a position
      const betTx = {
        type: "PlaceBet" as const,
        marketId: "market-resolve-1",
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

      // -- Action: resolve market to outcome A --
      const resolveRes = yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-resolve-1", result: "A" }),
        client.execute,
      );
      expect(resolveRes.status).toBe(200);
      yield* produceBlock;

      // -- Assert: market status is resolved with result A --
      const mktRes = yield* client.get("/internal/market/market-resolve-1");
      const { market } = (yield* mktRes.json) as { market: any; pool: any };
      expect(market.status).toBe("resolved");
      expect(market.result).toBe("A");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

  it.scoped("settle payout: winners credited, treasury reclaims remainder", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;

      // -- Setup: fund user, create market (seed 1000), bet 100 on A --
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
          id: "market-settle-1",
          name: "Chiefs vs Eagles",
          outcomes: ["Chiefs", "Eagles"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      const betTx = {
        type: "PlaceBet" as const,
        marketId: "market-settle-1",
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

      // Capture balances and position before resolution
      const userAddr = addressOf(testKeys.user.publicKey);
      const treasuryAddr = addressOf(testKeys.node.publicKey);

      const preUserRes = yield* client.get(`/internal/balance/${userAddr}`);
      const { balance: preUserBalance } = (yield* preUserRes.json) as { balance: number };

      const preTreasuryRes = yield* client.get(`/internal/balance/${treasuryAddr}`);
      const { balance: preTreasuryBalance } = (yield* preTreasuryRes.json) as { balance: number };

      const posRes = yield* client.get(`/internal/positions/${userAddr}`);
      const positions = (yield* posRes.json) as Array<{ shares: number }>;
      const userShares = positions[0].shares;

      // Get pool liquidity before resolution
      const poolRes = yield* client.get("/internal/market/market-settle-1");
      const { pool } = (yield* poolRes.json) as { market: any; pool: any };
      const poolLiquidity = pool.liquidity;

      // -- Action: resolve to A --
      yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-settle-1", result: "A" }),
        client.execute,
      );
      yield* produceBlock;

      // -- Assert: user credited by shares amount --
      const postUserRes = yield* client.get(`/internal/balance/${userAddr}`);
      const { balance: postUserBalance } = (yield* postUserRes.json) as { balance: number };
      expect(postUserBalance).toBe(preUserBalance + userShares);

      // -- Assert: treasury reclaimed remainder --
      const postTreasuryRes = yield* client.get(`/internal/balance/${treasuryAddr}`);
      const { balance: postTreasuryBalance } = (yield* postTreasuryRes.json) as { balance: number };
      const expectedReclaim = poolLiquidity - userShares;
      expect(postTreasuryBalance).toBe(preTreasuryBalance + expectedReclaim);

      // -- Assert: market is resolved --
      const mktRes = yield* client.get("/internal/market/market-settle-1");
      const { market } = (yield* mktRes.json) as { market: any; pool: any };
      expect(market.status).toBe("resolved");
      expect(market.result).toBe("A");
    }).pipe(Effect.provide(NodeTestLayer)),
  );

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

  it.scoped("market:resolved event emitted on resolution", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;
      const eventBus = yield* EventBus;

      yield* HttpClientRequest.post("/internal/create-market").pipe(
        HttpClientRequest.bodyUnsafeJson({
          id: "market-event-1",
          name: "Event Test",
          outcomes: ["A", "B"],
          closesAt: new Date(Date.now() + 86400000).toISOString(),
          seedAmount: 1000,
        }),
        client.execute,
      );
      yield* produceBlock;

      // Subscribe before resolution
      const stream = yield* eventBus.subscribe;
      const eventFiber = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.fork);
      yield* Effect.yieldNow();

      // Resolve market
      yield* HttpClientRequest.post("/internal/resolve-market").pipe(
        HttpClientRequest.bodyUnsafeJson({ id: "market-event-1", result: "A" }),
        client.execute,
      );
      yield* produceBlock;

      // Assert: market:resolved event received
      const events = Chunk.toArray(yield* Fiber.join(eventFiber));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("market:resolved");
      expect((events[0] as any).marketId).toBe("market-event-1");
      expect((events[0] as any).result).toBe("A");
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
});
