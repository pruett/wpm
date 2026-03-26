import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeClient } from "../src/node-client.js";
import { UserStore } from "../src/user-store.js";
import { makeRouter } from "../src/router.js";
import { calculateBuy, calculateSell, addressOf, SIGNUP_AIRDROP } from "@wpm/shared";
import type { SharePosition } from "@wpm/shared";
import { Stream } from "effect";

function makeStatefulMock() {
  const basePool = { marketId: "m1", sharesA: 1000, sharesB: 1000, k: 1_000_000, liquidity: 1000 };
  let pool = { ...basePool };
  const balances = new Map<string, number>();
  const positions = new Map<string, SharePosition>();
  const market = {
    id: "m1",
    name: "Chiefs vs Eagles",
    outcomes: ["Chiefs", "Eagles"] as [string, string],
    closesAt: "2026-04-01T00:00:00Z",
    status: "open" as const,
  };
  return Layer.succeed(NodeClient, {
    submitTransaction: (tx) =>
      Effect.sync(() => {
        if (tx.type === "PlaceBet") {
          const result = calculateBuy(pool, tx.outcome, tx.amount);
          pool = result.newPool;
          const addr = addressOf(tx.submitter);
          balances.set(addr, (balances.get(addr) ?? 0) - tx.amount);
          const key = `${addr}:${tx.marketId}:${tx.outcome}`;
          const existing = positions.get(key);
          positions.set(key, {
            owner: addr,
            marketId: tx.marketId,
            outcome: tx.outcome,
            shares: (existing?.shares ?? 0) + result.shares,
            costBasis: (existing?.costBasis ?? 0) + tx.amount,
          });
        }
        if (tx.type === "SellShares") {
          const result = calculateSell(pool, tx.outcome, tx.shares);
          pool = result.newPool;
          const addr = addressOf(tx.submitter);
          balances.set(addr, (balances.get(addr) ?? 0) + result.wpmReturned);
        }
      }),
    distribute: (_recipient, amount) =>
      Effect.sync(() => {
        const addr = addressOf(_recipient);
        balances.set(addr, (balances.get(addr) ?? 0) + amount);
      }),
    getMarkets: Effect.sync(() => [{ market, pool }]),
    getMarket: () => Effect.sync(() => ({ market, pool })),
    getBalance: (address) => Effect.sync(() => balances.get(address) ?? 0),
    getPositions: (address) =>
      Effect.sync(() => [...positions.values()].filter((p) => p.owner === address)),
    health: Effect.succeed(true),
    eventStream: Effect.succeed(Stream.empty),
  });
}

function makeResolvedMock() {
  const pool = { marketId: "m1", sharesA: 900, sharesB: 1100, k: 1_000_000, liquidity: 1100 };
  const market = {
    id: "m1",
    name: "Chiefs vs Eagles",
    outcomes: ["Chiefs", "Eagles"] as [string, string],
    closesAt: "2026-04-01T00:00:00Z",
    status: "resolved" as const,
    result: "A" as const,
  };
  return Layer.succeed(NodeClient, {
    submitTransaction: () => Effect.void,
    distribute: () => Effect.void,
    getMarkets: Effect.succeed([{ market, pool }]),
    getMarket: () => Effect.succeed({ market, pool }),
    getBalance: () => Effect.succeed(100_000),
    getPositions: () => Effect.succeed([]),
    health: Effect.succeed(true),
    eventStream: Effect.succeed(Stream.empty),
  });
}

function testLayer(mock: Layer.Layer<NodeClient>) {
  return Layer.mergeAll(mock, UserStore.Live()).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
}

/** Helper: register a user and return { token, address, balance } */
function registerUser(client: HttpClient.HttpClient, name: string) {
  return HttpClientRequest.post("/api/register").pipe(
    HttpClientRequest.bodyUnsafeJson({ name }),
    client.execute,
    Effect.flatMap((res) => res.json),
  ) as Effect.Effect<{ token: string; address: string; balance: number }>;
}

/** Helper: place a bet with auth token */
function placeBet(
  client: HttpClient.HttpClient,
  token: string,
  body: { marketId: string; outcome: string; amount: number },
) {
  return HttpClientRequest.post("/api/bet").pipe(
    HttpClientRequest.bodyUnsafeJson(body),
    HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
    client.execute,
  );
}

/** Helper: get balance with auth token */
function getBalance(client: HttpClient.HttpClient, token: string) {
  return HttpClientRequest.get("/api/balance").pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
    client.execute,
    Effect.flatMap((res) => res.json),
  ) as Effect.Effect<{ balance: number }>;
}

/** Helper: get positions with auth token */
function getPositions(client: HttpClient.HttpClient, token: string) {
  return HttpClientRequest.get("/api/positions").pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
    client.execute,
    Effect.flatMap((res) => res.json),
  ) as Effect.Effect<SharePosition[]>;
}

describe("API", () => {
  // --- Cycle 1: User registration creates wallet and funds it ---

  it.scoped("register creates funded wallet; balance endpoint returns it", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const reg = yield* registerUser(client, "Alice");
      expect(reg.token).toBeDefined();
      expect(reg.address).toBeDefined();
      expect(reg.balance).toBe(SIGNUP_AIRDROP);

      // GET /api/balance with token returns funded balance
      const bal = yield* getBalance(client, reg.token);
      expect(bal.balance).toBe(SIGNUP_AIRDROP);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  it.scoped("balance without token returns 401", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const res = yield* client
        .get("/api/balance")
        .pipe(Effect.flatMap((res) => Effect.succeed(res)));
      expect(res.status).toBe(401);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  it.scoped("balance with invalid token returns 401", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const res = yield* HttpClientRequest.get("/api/balance").pipe(
        HttpClientRequest.setHeader("Authorization", "Bearer bad-token"),
        client.execute,
      );
      expect(res.status).toBe(401);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  // --- Cycle 2: Authenticated bet uses user's wallet ---

  it.scoped("bet with auth deducts from user balance", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const reg = yield* registerUser(client, "Alice");
      const betRes = yield* placeBet(client, reg.token, {
        marketId: "m1",
        outcome: "A",
        amount: 100,
      });
      expect(betRes.status).toBe(200);

      const bal = yield* getBalance(client, reg.token);
      expect(bal.balance).toBe(SIGNUP_AIRDROP - 100);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  it.scoped("bet without auth returns 401", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const res = yield* HttpClientRequest.post("/api/bet").pipe(
        HttpClientRequest.bodyUnsafeJson({ marketId: "m1", outcome: "A", amount: 100 }),
        client.execute,
      );
      expect(res.status).toBe(401);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  // --- Cycle 3: Positions after betting ---

  it.scoped("positions show shares after bet", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const reg = yield* registerUser(client, "Alice");
      yield* placeBet(client, reg.token, { marketId: "m1", outcome: "A", amount: 100 });

      const positions = yield* getPositions(client, reg.token);
      expect(positions).toHaveLength(1);
      expect(positions[0].marketId).toBe("m1");
      expect(positions[0].outcome).toBe("A");
      expect(positions[0].shares).toBeGreaterThan(0);
      expect(positions[0].costBasis).toBe(100);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  // --- Cycle 4: Two users bet independently ---

  it.scoped("two users: balances and positions are isolated", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const alice = yield* registerUser(client, "Alice");
      const bob = yield* registerUser(client, "Bob");

      // Alice bets on A
      yield* placeBet(client, alice.token, { marketId: "m1", outcome: "A", amount: 200 });
      // Bob bets on B
      yield* placeBet(client, bob.token, { marketId: "m1", outcome: "B", amount: 300 });

      // Balances are independent
      const aliceBal = yield* getBalance(client, alice.token);
      const bobBal = yield* getBalance(client, bob.token);
      expect(aliceBal.balance).toBe(SIGNUP_AIRDROP - 200);
      expect(bobBal.balance).toBe(SIGNUP_AIRDROP - 300);

      // Positions are isolated
      const alicePos = yield* getPositions(client, alice.token);
      const bobPos = yield* getPositions(client, bob.token);
      expect(alicePos).toHaveLength(1);
      expect(alicePos[0].outcome).toBe("A");
      expect(bobPos).toHaveLength(1);
      expect(bobPos[0].outcome).toBe("B");
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  // --- Existing tests (updated for new auth model) ---

  it.scoped("enrichment and bet flow: prices, multipliers, bet, odds shift", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      // Register to get auth token
      const reg = yield* registerUser(client, "Trader");

      // -- GET /api/markets: enrichment with prices and multipliers --
      const res1 = yield* client.get("/api/markets");
      const markets1 = (yield* res1.json) as any[];
      expect(markets1).toHaveLength(1);
      const m1 = markets1[0];
      expect(m1.priceA).toBeCloseTo(0.5);
      expect(m1.priceB).toBeCloseTo(0.5);
      expect(m1.multiplierA).toBeCloseTo(2.0);
      expect(m1.multiplierB).toBeCloseTo(2.0);
      expect(m1.pool).toBeDefined();

      // Invariant: multiplier = 1/price
      expect(m1.multiplierA).toBeCloseTo(1 / m1.priceA, 6);
      expect(m1.multiplierB).toBeCloseTo(1 / m1.priceB, 6);

      // -- POST /api/bet: place bet on outcome A (now needs auth) --
      const betRes = yield* placeBet(client, reg.token, {
        marketId: "m1",
        outcome: "A",
        amount: 100,
      });
      expect(betRes.status).toBe(200);
      const betBody = (yield* betRes.json) as { success: boolean };
      expect(betBody.success).toBe(true);

      // -- GET /api/markets: odds shifted after bet --
      const res2 = yield* client.get("/api/markets");
      const m2 = ((yield* res2.json) as any[])[0];
      expect(m2.priceA).toBeGreaterThan(0.5);
      expect(m2.priceB).toBeLessThan(0.5);

      // Invariant still holds after the shift
      expect(m2.multiplierA).toBeCloseTo(1 / m2.priceA, 6);
      expect(m2.multiplierB).toBeCloseTo(1 / m2.priceB, 6);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  it.scoped("sell via API: signs tx and submits, odds shift back", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const reg = yield* registerUser(client, "Trader");

      // Buy first to shift prices
      yield* placeBet(client, reg.token, { marketId: "m1", outcome: "A", amount: 100 });

      // Note prices after buy
      const res1 = yield* client.get("/api/markets");
      const m1 = ((yield* res1.json) as any[])[0];
      expect(m1.priceA).toBeGreaterThan(0.5);

      // -- POST /api/sell: sell shares back (now needs auth) --
      const sellRes = yield* HttpClientRequest.post("/api/sell").pipe(
        HttpClientRequest.bodyUnsafeJson({ marketId: "m1", outcome: "A", shares: 50 }),
        HttpClientRequest.setHeader("Authorization", `Bearer ${reg.token}`),
        client.execute,
      );
      expect(sellRes.status).toBe(200);
      const sellBody = (yield* sellRes.json) as { success: boolean };
      expect(sellBody.success).toBe(true);

      // -- GET /api/markets: prices shifted back after sell --
      const res2 = yield* client.get("/api/markets");
      const m2 = ((yield* res2.json) as any[])[0];
      expect(m2.priceA).toBeLessThan(m1.priceA);

      // Invariant still holds
      expect(m2.multiplierA).toBeCloseTo(1 / m2.priceA, 6);
      expect(m2.multiplierB).toBeCloseTo(1 / m2.priceB, 6);
    }).pipe(Effect.provide(testLayer(makeStatefulMock()))),
  );

  it.scoped("resolved market enrichment: terminal prices 1.0/0.0", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect(), Effect.forkScoped);
      const client = yield* HttpClient.HttpClient;

      const res = yield* client.get("/api/markets");
      const markets = (yield* res.json) as any[];
      expect(markets).toHaveLength(1);
      const m = markets[0];
      expect(m.status).toBe("resolved");
      expect(m.result).toBe("A");
      expect(m.priceA).toBe(1.0);
      expect(m.priceB).toBe(0.0);
    }).pipe(Effect.provide(testLayer(makeResolvedMock()))),
  );
});
