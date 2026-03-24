# Tracer Bullet 1: TDD Implementation Guide

A single end-to-end flow — **a user views a market and places a bet** — implemented as strict RED→GREEN vertical slices. Each cycle is one failing test followed by the minimum code to pass it.

**Intentional shortcuts:** No auth (hardcoded user), no ESPN (hardcoded game), no market resolution or payout, no sell flow.

---

## Packages

**shared** — Types, AMM math, and crypto. Pure TypeScript, no Effect dependency. Defines every type that crosses a package boundary.

**node** — Blockchain core on port 4000. Accepts transactions, validates them, applies them to chain state, produces blocks on a 5-second interval, persists the chain, and broadcasts events over SSE. Internal HTTP endpoints only.

**api** — HTTP gateway on port 3000. Translates external requests into node calls, enriches responses with computed prices/multipliers, relays SSE events. Owns no chain state.

**oracle** — Market creator. Sends market parameters to the node via `POST /internal/create-market`, then idles. No keys — market creation is a system operation signed by the node.

**web** — React SPA. Fetches markets from the API, renders live odds, lets users place bets. Subscribes to SSE for real-time updates.

---

## Communication Flow

```
Oracle ──POST /internal/create-market──▶ Node
                                          │
                                   CreateMarket tx applied
                                   AMM pool seeded (50/50)
                                          │
Web ◀────GET /api/markets──── API ◀──GET /internal/markets──── Node
 │
 │  User clicks "Buy Chiefs"
 │
Web ──POST /api/bet──▶ API ──POST /internal/transaction──▶ Node
                                                             │
                                                      PlaceBet tx applied
                                                      AMM reprices
                                                             │
Web ◀──SSE price:update──── API ◀──SSE trade:executed──── Node
```

**Node (internal, port 4000):**
`POST /internal/transaction`, `POST /internal/distribute`, `POST /internal/create-market`, `GET /internal/markets`, `GET /internal/market/:id`, `GET /internal/balance/:address`, `GET /internal/positions/:address`, `GET /internal/health`, `GET /internal/events` (SSE)

**API (external, port 3000):**
`GET /api/markets`, `POST /api/bet`, `GET /events/stream` (SSE relay)

---

## Shared Types

These types form the contract between packages. Defined in `@wpm/shared`, imported everywhere.

```typescript
type Transaction =
  | {
      type: "Distribute";
      to: string;
      amount: number;
      memo: string;
      signature: string;
      timestamp: string;
    }
  | {
      type: "CreateMarket";
      id: string;
      name: string;
      outcomes: [string, string];
      closesAt: string;
      seedAmount: number;
      signature: string;
      timestamp: string;
    }
  | {
      type: "PlaceBet";
      marketId: string;
      outcome: "A" | "B";
      amount: number;
      submitter: string;
      signature: string;
      timestamp: string;
    };

type Block = {
  index: number;
  timestamp: string;
  transactions: Transaction[];
  previousHash: string;
  hash: string;
  signature: string;
  signer: string;
};

type Market = {
  id: string;
  name: string;
  outcomes: [string, string];
  closesAt: string;
  status: "open" | "closed" | "resolved" | "cancelled";
  result?: "A" | "B";
};

type AMMPool = {
  marketId: string;
  sharesA: number;
  sharesB: number;
  k: number; // constant product invariant
  liquidity: number; // WPM locked in pool
};

type SharePosition = {
  owner: string;
  marketId: string;
  outcome: "A" | "B";
  shares: number;
  costBasis: number;
};

type MarketWithOdds = Market & {
  priceA: number; // 0.00–1.00, implied probability
  priceB: number;
  multiplierA: number; // payout multiplier (1/price)
  multiplierB: number;
  pool: AMMPool;
};

// SSE events
type TradeExecutedEvent = {
  type: "trade:executed";
  marketId: string;
  pool: AMMPool;
};

type PriceUpdateEvent = {
  type: "price:update";
  marketId: string;
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
};
```

Note: `CreateMarket` has no `submitter` field — it's a system transaction created and signed by the node (like `Distribute`). `PlaceBet` has `submitter` because the user must prove ownership of their wallet.

---

## AMM Pricing

Two-step **mint-then-swap** constant product model (x \* y = k).

When a user buys outcome A shares with `amount` WPM:

1. **Mint**: `amount` shares of both A and B are created (1 WPM = 1 share of each)
2. **Swap**: The unwanted B shares go into the pool; the user receives additional A shares from the pool

```
Pool before: sharesA=1000, sharesB=1000, k=1,000,000
User buys 100 WPM of outcome A:

  Mint: user gets 100 A + 100 B
  Swap 100 B into pool:
    newSharesB = 1000 + 100 = 1100
    newSharesA = 1,000,000 / 1100 ≈ 909.09
    swapOut = 1000 - 909.09 ≈ 90.91

  Total A shares to user = 100 + 90.91 ≈ 190.91
  Pool after: sharesA ≈ 909.09, sharesB = 1100, k = 1,000,000

Prices derived from pool ratio:
  priceA = sharesB / (sharesA + sharesB) ≈ 0.547
  priceB = sharesA / (sharesA + sharesB) ≈ 0.453
  Sum = 1.0 (always)
```

Pure functions in `@wpm/shared`: `initializePool`, `calculateBuy`, `calculatePrices`.

---

## Key Management

Two key pairs:

- **Node (PoA signer)** — signs blocks and all system transactions (Distribute, CreateMarket). The node is the sole authority — it creates markets and mints tokens using its own key. Treasury address = node's public key. Loaded from disk in production, hardcoded in tests.
- **User** — generated in-memory by the API on startup. Signs PlaceBet transactions. The only key that proves "this bet came from this wallet."

Transaction signing: `JSON.stringify` all fields except `signature` with sorted keys, sign with RSA private key, verify with public key.

---

## Effect-TS Quick Reference

```typescript
// Effect<A, E, R> — a program producing A, failing with E, requiring R
const program: Effect<number> = Effect.succeed(42);

// Generator syntax — sequential composition
const result = Effect.gen(function* () {
  const a = yield* Effect.succeed(1);
  const b = yield* Effect.succeed(2);
  return a + b;
});

// Context.Tag — define a service interface
class Database extends Context.Tag("Database")<
  Database,
  { readonly query: (sql: string) => Effect<Row[]> }
>() {}

// Layer — build a service implementation
const DbLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    return { query: (sql) => Effect.try(() => db.execute(sql)) };
  }),
);

// Ref — thread-safe mutable state
const counter = yield * Ref.make(0);
yield * Ref.update(counter, (n) => n + 1);

// PubSub — fan-out messaging
const hub = yield * PubSub.unbounded<Event>();
yield * hub.publish(event);

// Data.TaggedError — typed, discriminated errors
class NotFound extends Data.TaggedError("NotFound")<{ id: string }> {}

// Schedule — recurring tasks
Effect.repeat(task, Schedule.fixed("5 seconds"));

// HTTP (from @effect/platform)
HttpRouter.empty.pipe(
  HttpRouter.get(
    "/path",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json({ ok: true });
    }),
  ),
  HttpServer.serveEffect(),
);
```

**Dependencies to install:**

```bash
# node, api, oracle packages:
bun add effect @effect/platform @effect/platform-node
bun add -d @effect/vitest

# shared stays pure — no new deps
```

---

## Testing Patterns

### Test Isolation

Each test gets its own server and fresh state using `it.scoped` from `@effect/vitest`:

```typescript
import { it } from "@effect/vitest";

it.scoped("test name", () =>
  Effect.gen(function* () {
    // test body — services and HTTP server available here
  }).pipe(Effect.provide(TestLayer)),
);
```

`NodeHttpServer.layerTest` starts an HTTP server on a **random port** and provides a pre-configured `HttpClient` pointing at it.

### Mocking Boundaries

Mock only at system boundaries — disk I/O and inter-service HTTP:

| Boundary           | Test variant                                          |
| ------------------ | ----------------------------------------------------- |
| Disk (chain JSONL) | `Persistence.Test` — in-memory Ref                    |
| Disk (key files)   | `Keys.Test` — hardcoded keypairs                      |
| HTTP (node↔api)    | `Layer.succeed(NodeClient, {...})`                    |
| Everything else    | **Live** (ChainState, Mempool, EventBus, AMM, crypto) |

### Block Production in Tests

The node produces blocks on a 5-second timer in production. Tests skip the timer — `produceBlock` is exported as a standalone Effect and called directly. This is deterministic and still tests through the HTTP interface (submit via POST, query via GET).

```typescript
// In test: submit tx via HTTP, then trigger block production
yield * submitTx(client, tx);
yield * produceBlock; // drains mempool, builds and applies block
// Now query results via HTTP
```

### Node Test Layer

```typescript
const NodeTestLayer = Layer.mergeAll(
  ChainState.Live,
  EventBus.Live,
  Persistence.Test,
  Keys.Test,
).pipe(Layer.provideMerge(Mempool.Live), Layer.provideMerge(NodeHttpServer.layerTest));

// Helper: apply genesis + serve router (used by every node test)
const serveNodeForTest = Effect.gen(function* () {
  const chainState = yield* ChainState;
  const keys = yield* Keys;
  const genesis = createGenesisBlock(keys);
  yield* chainState.applyBlock(genesis);
  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect());
});
```

---

## Cycle 1 — AMM Math

Pure functions in `@wpm/shared`. Standard vitest, no Effect. One test exercises the full CPMM lifecycle: buy, price computation, and invariant preservation across multiple trades.

---

### Test

```typescript
// packages/shared/tests/amm.test.ts
import { describe, test, expect } from "vitest";
import { initializePool, calculateBuy, calculatePrices } from "../src/amm/index.js";

describe("AMM", () => {
  test("full CPMM lifecycle: buy, prices, and invariants", () => {
    const pool = initializePool("market-1", 1000);

    // -- Buy 100 WPM of outcome A --
    const { shares, newPool } = calculateBuy(pool, "A", 100);

    // Correct shares returned
    expect(shares).toBeCloseTo(190.91, 1);
    expect(shares).toBeGreaterThan(100); // always more than raw amount
    expect(shares).toBeLessThan(200); // can't exceed 2x in single trade

    // Pool state updated
    expect(newPool.sharesB).toBe(1100);
    expect(newPool.sharesA).toBeCloseTo(909.09, 1);
    expect(newPool.liquidity).toBe(1100); // original 1000 + 100 from bet

    // Prices shift toward bought outcome
    const prices = calculatePrices(newPool);
    expect(prices.priceA).toBeGreaterThan(0.5);
    expect(prices.priceB).toBeLessThan(0.5);

    // Invariant: prices always sum to 1
    expect(prices.priceA + prices.priceB).toBeCloseTo(1.0, 10);

    // Invariant: constant product k preserved
    expect(newPool.sharesA * newPool.sharesB).toBeCloseTo(pool.k, 4);

    // -- Multi-trade sweep: invariants hold across varied trades --
    let p = pool;
    const trades: Array<["A" | "B", number]> = [
      ["A", 100],
      ["B", 50],
      ["A", 200],
      ["B", 150],
      ["A", 75],
    ];
    for (const [outcome, amount] of trades) {
      const result = calculateBuy(p, outcome, amount);
      p = result.newPool;
      const pr = calculatePrices(p);
      expect(pr.priceA + pr.priceB).toBeCloseTo(1.0, 10);
      expect(p.sharesA * p.sharesB).toBeCloseTo(pool.k, 4);
    }
  });
});
```

### Implementation

**New file: `packages/shared/src/types/index.ts`**

Define all shared types from the Shared Types section above: `Transaction`, `Block`, `Market`, `AMMPool`, `SharePosition`, `MarketWithOdds`, `TradeExecutedEvent`, `PriceUpdateEvent`.

**New file: `packages/shared/src/amm/index.ts`**

```typescript
import type { AMMPool } from "../types/index.js";

export function initializePool(marketId: string, seedAmount: number): AMMPool {
  return {
    marketId,
    sharesA: seedAmount,
    sharesB: seedAmount,
    k: seedAmount * seedAmount,
    liquidity: seedAmount,
  };
}

export function calculateBuy(
  pool: AMMPool,
  outcome: "A" | "B",
  amount: number,
): { shares: number; newPool: AMMPool } {
  const [target, other] =
    outcome === "A" ? [pool.sharesA, pool.sharesB] : [pool.sharesB, pool.sharesA];

  // Swap: user sends `amount` of the OTHER outcome's shares into pool
  const newOther = other + amount;
  const newTarget = pool.k / newOther;
  const swapOut = target - newTarget;

  // Total shares = minted + swapped
  const totalShares = amount + swapOut;

  const newPool: AMMPool = {
    marketId: pool.marketId,
    sharesA: outcome === "A" ? newTarget : newOther,
    sharesB: outcome === "A" ? newOther : newTarget,
    k: pool.k,
    liquidity: pool.liquidity + amount,
  };

  return { shares: totalShares, newPool };
}

export function calculatePrices(pool: AMMPool): { priceA: number; priceB: number } {
  const total = pool.sharesA + pool.sharesB;
  return {
    priceA: pool.sharesB / total,
    priceB: pool.sharesA / total,
  };
}
```

**New file: `packages/shared/src/index.ts`** — re-export:

```typescript
export * from "./types/index.js";
export * from "./amm/index.js";
```

---

## Cycle 2 — Node Integration

One integration test that exercises the entire user journey through the node's HTTP API: genesis, funding, market creation, bet placement, and SSE event emission. This is the most expensive cycle — it stands up the entire node skeleton.

---

### Test

```typescript
// packages/node/tests/node.test.ts
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Fiber, Stream, Option } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeTestLayer, serveNodeForTest, testKeys, produceBlock } from "./helpers.js";
import { sign, serializeTx, calculatePrices } from "@wpm/shared";

describe("Node", () => {
  it.scoped("full flow: genesis → fund → market → bet → SSE", () =>
    Effect.gen(function* () {
      yield* serveNodeForTest;
      const client = yield* HttpClient.HttpClient;

      // -- Genesis: treasury holds initial supply --
      const treasuryRes = yield* client.get(`/internal/balance/${testKeys.node.publicKey}`);
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

      // -- Subscribe to SSE before placing bet --
      const eventFiber = yield* client.get("/internal/events").pipe(
        Effect.flatMap((res) =>
          res.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapAccum("", (buffer, line) => {
              if (line.startsWith("data: ")) return [buffer + line.slice(6), undefined];
              if (line === "" && buffer !== "") return ["", buffer];
              return [buffer, undefined];
            }),
            Stream.filterMap(Option.fromNullable),
            Stream.map((s) => JSON.parse(s)),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
        Effect.fork,
      );
      yield* Effect.sleep("50 millis");

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
      const userBalRes = yield* client.get(`/internal/balance/${testKeys.user.publicKey}`);
      const { balance: userBalance } = (yield* userBalRes.json) as { balance: number };
      expect(userBalance).toBe(100_000 - 100);

      // -- Verify position created --
      const posRes = yield* client.get(`/internal/positions/${testKeys.user.publicKey}`);
      const positions = (yield* posRes.json) as Array<{ outcome: string; shares: number }>;
      expect(positions).toHaveLength(1);
      expect(positions[0].outcome).toBe("A");
      expect(positions[0].shares).toBeGreaterThan(0);

      // -- Verify SSE: trade:executed event received --
      const events = yield* Fiber.join(eventFiber);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("trade:executed");
      expect(events[0].marketId).toBe("market-1");
      expect(events[0].pool.sharesA).not.toBe(events[0].pool.sharesB);
    }).pipe(Effect.provide(NodeTestLayer)),
  );
});
```

### Implementation

This cycle creates the entire node skeleton. All files listed in dependency order.

**`packages/shared/src/crypto/index.ts`** — signing and verification:

```typescript
import { createHash, generateKeyPairSync, sign as rsaSign, verify as rsaVerify } from "node:crypto";

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sign(data: string, privateKey: string): string {
  return rsaSign("sha256", Buffer.from(data), privateKey).toString("base64");
}

export function verify(data: string, signature: string, publicKey: string): boolean {
  return rsaVerify("sha256", Buffer.from(data), publicKey, Buffer.from(signature, "base64"));
}

// Canonical serialization: sorted keys, signature excluded
export function serializeTx(tx: Record<string, unknown>): string {
  const keys = Object.keys(tx)
    .filter((k) => k !== "signature")
    .sort();
  const obj: Record<string, unknown> = {};
  for (const k of keys) obj[k] = tx[k];
  return JSON.stringify(obj);
}
```

Re-export from `packages/shared/src/index.ts`: `export * from "./crypto/index.js"`

**`packages/node/src/errors.ts`**:

```typescript
import { Data } from "effect";

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly code: string;
  readonly message: string;
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly message: string;
}> {}
```

**`packages/node/src/keys.ts`**:

```typescript
import { Context, Effect, Layer } from "effect";
import { readFileSync } from "node:fs";

export class Keys extends Context.Tag("Keys")<
  Keys,
  {
    readonly poaPublicKey: string;
    readonly poaPrivateKey: string;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.try({
      try: () => ({
        poaPublicKey: readFileSync("./data/keys/node.pub", "utf-8").trim(),
        poaPrivateKey: readFileSync("./data/keys/node.pem", "utf-8").trim(),
      }),
      catch: (e) => new Error(`Failed to load keys: ${e}`),
    }),
  );
}
```

**`packages/node/src/chain-state.ts`**:

```typescript
import { Context, Effect, Layer, Ref } from "effect";
import type { Block, Market, AMMPool, SharePosition } from "@wpm/shared";
import { initializePool, calculateBuy } from "@wpm/shared";

export interface ChainStateData {
  readonly chain: Block[];
  readonly balances: Map<string, number>;
  readonly markets: Map<string, Market>;
  readonly pools: Map<string, AMMPool>;
  readonly positions: Map<string, SharePosition>; // key: "owner:marketId:outcome"
}

function emptyState(): ChainStateData {
  return {
    chain: [],
    balances: new Map(),
    markets: new Map(),
    pools: new Map(),
    positions: new Map(),
  };
}

// Pure state transition — the core of the blockchain
function applyBlockPure(state: ChainStateData, block: Block): ChainStateData {
  const balances = new Map(state.balances);
  const markets = new Map(state.markets);
  const pools = new Map(state.pools);
  const positions = new Map(state.positions);
  const chain = [...state.chain, block];

  for (const tx of block.transactions) {
    switch (tx.type) {
      case "Distribute":
        balances.set(tx.to, (balances.get(tx.to) ?? 0) + tx.amount);
        break;

      case "CreateMarket":
        markets.set(tx.id, {
          id: tx.id,
          name: tx.name,
          outcomes: tx.outcomes,
          closesAt: tx.closesAt,
          status: "open",
        });
        pools.set(tx.id, initializePool(tx.id, tx.seedAmount));
        // Seed funded by treasury (block signer)
        balances.set(block.signer, (balances.get(block.signer) ?? 0) - tx.seedAmount);
        break;

      case "PlaceBet": {
        const pool = pools.get(tx.marketId)!;
        const { shares, newPool } = calculateBuy(pool, tx.outcome, tx.amount);
        pools.set(tx.marketId, newPool);
        balances.set(tx.submitter, (balances.get(tx.submitter) ?? 0) - tx.amount);
        const posKey = `${tx.submitter}:${tx.marketId}:${tx.outcome}`;
        const existing = positions.get(posKey);
        positions.set(posKey, {
          owner: tx.submitter,
          marketId: tx.marketId,
          outcome: tx.outcome,
          shares: (existing?.shares ?? 0) + shares,
          costBasis: (existing?.costBasis ?? 0) + tx.amount,
        });
        break;
      }
    }
  }

  return { chain, balances, markets, pools, positions };
}

export class ChainState extends Context.Tag("ChainState")<
  ChainState,
  {
    readonly get: Effect.Effect<ChainStateData>;
    readonly getBalance: (address: string) => Effect.Effect<number>;
    readonly getMarket: (id: string) => Effect.Effect<Market | undefined>;
    readonly getMarkets: Effect.Effect<Array<{ market: Market; pool: AMMPool }>>;
    readonly getPool: (marketId: string) => Effect.Effect<AMMPool | undefined>;
    readonly getPositions: (owner: string) => Effect.Effect<SharePosition[]>;
    readonly applyBlock: (block: Block) => Effect.Effect<void>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const ref = yield* Ref.make<ChainStateData>(emptyState());
      return {
        get: Ref.get(ref),
        getBalance: (addr) => Effect.map(Ref.get(ref), (s) => s.balances.get(addr) ?? 0),
        getMarket: (id) => Effect.map(Ref.get(ref), (s) => s.markets.get(id)),
        getMarkets: Effect.map(Ref.get(ref), (s) =>
          Array.from(s.markets.values()).map((m) => ({ market: m, pool: s.pools.get(m.id)! })),
        ),
        getPool: (id) => Effect.map(Ref.get(ref), (s) => s.pools.get(id)),
        getPositions: (owner) =>
          Effect.map(Ref.get(ref), (s) =>
            Array.from(s.positions.values()).filter((p) => p.owner === owner),
          ),
        applyBlock: (block) => Ref.update(ref, (state) => applyBlockPure(state, block)),
      };
    }),
  );
}
```

**`packages/node/src/event-bus.ts`**:

```typescript
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import type { Scope } from "effect";
import type { TradeExecutedEvent } from "@wpm/shared";

export class EventBus extends Context.Tag("EventBus")<
  EventBus,
  {
    readonly publish: (event: TradeExecutedEvent) => Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<Stream.Stream<TradeExecutedEvent>, never, Scope>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<TradeExecutedEvent>();
      return {
        publish: (event) => pubsub.publish(event),
        subscribe: Effect.map(pubsub.subscribe, (queue) => Stream.fromQueue(queue)),
      };
    }),
  );
}
```

**`packages/node/src/persistence.ts`**:

```typescript
import { Context, Effect, Layer, Ref } from "effect";
import type { Block } from "@wpm/shared";
import { PersistenceError } from "./errors.js";
import { readFileSync, appendFileSync, existsSync } from "node:fs";

export class Persistence extends Context.Tag("Persistence")<
  Persistence,
  {
    readonly appendBlock: (block: Block) => Effect.Effect<void, PersistenceError>;
    readonly loadChain: Effect.Effect<Block[], PersistenceError>;
  }
>() {
  static Live = Layer.succeed(this, {
    appendBlock: (block) =>
      Effect.try({
        try: () => appendFileSync("./data/chain.jsonl", JSON.stringify(block) + "\n"),
        catch: (e) => new PersistenceError({ message: `${e}` }),
      }),
    loadChain: Effect.try({
      try: () => {
        if (!existsSync("./data/chain.jsonl")) return [];
        return readFileSync("./data/chain.jsonl", "utf-8")
          .trimEnd()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      },
      catch: (e) => new PersistenceError({ message: `${e}` }),
    }),
  });

  static Test = Layer.effect(
    this,
    Effect.gen(function* () {
      const ref = yield* Ref.make<Block[]>([]);
      return {
        appendBlock: (block: Block) => Ref.update(ref, (bs) => [...bs, block]),
        loadChain: Ref.get(ref),
      };
    }),
  );
}
```

**`packages/node/src/mempool.ts`**:

```typescript
import { Context, Effect, Layer, Ref } from "effect";
import type { Transaction } from "@wpm/shared";
import { ChainState } from "./chain-state.js";
import { Keys } from "./keys.js";
import { ValidationError } from "./errors.js";
import { validateTransaction } from "./validation.js";

export class Mempool extends Context.Tag("Mempool")<
  Mempool,
  {
    readonly add: (tx: Transaction) => Effect.Effect<void, ValidationError>;
    readonly drain: (max: number) => Effect.Effect<Transaction[]>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const chainState = yield* ChainState;
      const keys = yield* Keys;
      const ref = yield* Ref.make<Transaction[]>([]);

      return {
        add: (tx) =>
          Effect.gen(function* () {
            const state = yield* chainState.get;
            yield* validateTransaction(tx, state, keys);
            yield* Ref.update(ref, (q) => [...q, tx]);
          }),
        drain: (max) => Ref.modify(ref, (q) => [q.slice(0, max), q.slice(max)]),
      };
    }),
  );
}
```

**`packages/node/src/validation.ts`**:

```typescript
import { Effect } from "effect";
import type { Transaction } from "@wpm/shared";
import { verify, serializeTx } from "@wpm/shared";
import type { ChainStateData } from "./chain-state.js";
import type { Keys } from "./keys.js";
import { ValidationError } from "./errors.js";

export function validateTransaction(
  tx: Transaction,
  state: ChainStateData,
  keys: Context.Tag.Service<typeof Keys>,
): Effect.Effect<void, ValidationError> {
  return Effect.gen(function* () {
    // System transactions (Distribute, CreateMarket) are created by the node
    // and signed with the PoA key — no external signature verification needed
    if (tx.type === "Distribute") return;

    if (tx.type === "CreateMarket") {
      if (state.markets.has(tx.id)) {
        return yield* Effect.fail(
          new ValidationError({
            code: "MARKET_EXISTS",
            message: `Market ${tx.id} already exists`,
          }),
        );
      }
      const treasuryBalance = state.balances.get(keys.poaPublicKey) ?? 0;
      if (treasuryBalance < tx.seedAmount) {
        return yield* Effect.fail(
          new ValidationError({
            code: "INSUFFICIENT_BALANCE",
            message: "Treasury cannot afford seed amount",
          }),
        );
      }
      return;
    }

    // PlaceBet: verify user signature and business rules
    if (tx.type === "PlaceBet") {
      const data = serializeTx(tx as Record<string, unknown>);
      if (!verify(data, tx.signature, tx.submitter)) {
        return yield* Effect.fail(
          new ValidationError({
            code: "INVALID_SIGNATURE",
            message: "Signature verification failed",
          }),
        );
      }
      const market = state.markets.get(tx.marketId);
      if (!market) {
        return yield* Effect.fail(
          new ValidationError({
            code: "MARKET_NOT_FOUND",
            message: `Market ${tx.marketId} not found`,
          }),
        );
      }
      if (market.status !== "open") {
        return yield* Effect.fail(
          new ValidationError({
            code: "MARKET_CLOSED",
            message: "Market is not open",
          }),
        );
      }
      const balance = state.balances.get(tx.submitter) ?? 0;
      if (balance < tx.amount) {
        return yield* Effect.fail(
          new ValidationError({
            code: "INSUFFICIENT_BALANCE",
            message: "Not enough WPM",
          }),
        );
      }
    }
  });
}
```

**`packages/node/src/genesis.ts`**:

```typescript
import type { Block, Transaction } from "@wpm/shared";
import { sha256, sign, serializeTx } from "@wpm/shared";

const INITIAL_SUPPLY = 10_000_000;

export function createGenesisBlock(keys: { poaPublicKey: string; poaPrivateKey: string }): Block {
  const tx: Transaction = {
    type: "Distribute",
    to: keys.poaPublicKey, // treasury = PoA signer
    amount: INITIAL_SUPPLY,
    memo: "genesis",
    signature: "",
    timestamp: new Date().toISOString(),
  };
  tx.signature = sign(serializeTx(tx as Record<string, unknown>), keys.poaPrivateKey);

  const block: Block = {
    index: 0,
    timestamp: new Date().toISOString(),
    transactions: [tx],
    previousHash: "0".repeat(64),
    hash: "",
    signature: "",
    signer: keys.poaPublicKey,
  };
  block.hash = sha256(JSON.stringify({ ...block, hash: "", signature: "" }));
  block.signature = sign(block.hash, keys.poaPrivateKey);

  return block;
}
```

**`packages/node/src/producer.ts`** — export `produceBlock` for test use:

```typescript
import { Effect } from "effect";
import type { Block, Transaction } from "@wpm/shared";
import { sha256, sign } from "@wpm/shared";
import { ChainState } from "./chain-state.js";
import { Mempool } from "./mempool.js";
import { Persistence } from "./persistence.js";
import { Keys } from "./keys.js";
import { EventBus } from "./event-bus.js";

function buildBlock(
  index: number,
  txs: Transaction[],
  previousHash: string,
  keys: { poaPublicKey: string; poaPrivateKey: string },
): Block {
  const block: Block = {
    index,
    timestamp: new Date().toISOString(),
    transactions: txs,
    previousHash,
    hash: "",
    signature: "",
    signer: keys.poaPublicKey,
  };
  block.hash = sha256(JSON.stringify({ ...block, hash: "", signature: "" }));
  block.signature = sign(block.hash, keys.poaPrivateKey);
  return block;
}

// Exported for direct use in tests — no timer dependency
export const produceBlock = Effect.gen(function* () {
  const mempool = yield* Mempool;
  const chainState = yield* ChainState;
  const persistence = yield* Persistence;
  const keys = yield* Keys;
  const eventBus = yield* EventBus;

  const txs = yield* mempool.drain(100);
  if (txs.length === 0) return;

  const state = yield* chainState.get;
  const prevHash =
    state.chain.length > 0 ? state.chain[state.chain.length - 1].hash : "0".repeat(64);

  const block = buildBlock(state.chain.length, txs, prevHash, keys);

  yield* persistence.appendBlock(block);
  yield* chainState.applyBlock(block);

  // Emit SSE events for trades
  for (const tx of txs) {
    if (tx.type === "PlaceBet") {
      const pool = yield* chainState.getPool(tx.marketId);
      if (pool) yield* eventBus.publish({ type: "trade:executed", marketId: tx.marketId, pool });
    }
  }
});
```

**`packages/node/src/router.ts`** — complete router with all endpoints:

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse, HttpServer } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import type { Transaction } from "@wpm/shared";
import { sign, serializeTx } from "@wpm/shared";
import { ChainState } from "./chain-state.js";
import { Mempool } from "./mempool.js";
import { Keys } from "./keys.js";
import { EventBus } from "./event-bus.js";

const AddressParams = Schema.Struct({ address: Schema.String });
const IdParams = Schema.Struct({ id: Schema.String });
const DistributeBody = Schema.Struct({
  recipient: Schema.String,
  amount: Schema.Number,
  reason: Schema.String,
});
const CreateMarketBody = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  outcomes: Schema.Tuple(Schema.String, Schema.String),
  closesAt: Schema.String,
  seedAmount: Schema.Number,
});

function makeSystemTx(
  fields: Record<string, unknown>,
  poaKeys: { poaPublicKey: string; poaPrivateKey: string },
): Transaction {
  const tx = { ...fields, timestamp: new Date().toISOString(), signature: "" };
  tx.signature = sign(serializeTx(tx), poaKeys.poaPrivateKey);
  return tx as Transaction;
}

export const makeRouter = Effect.gen(function* () {
  const chainState = yield* ChainState;
  const mempool = yield* Mempool;
  const keys = yield* Keys;
  const eventBus = yield* EventBus;

  return HttpRouter.empty.pipe(
    HttpRouter.get("/internal/health", HttpServerResponse.json({ status: "ok" })),

    HttpRouter.get(
      "/internal/balance/:address",
      Effect.gen(function* () {
        const { address } = yield* HttpRouter.schemaPathParams(AddressParams);
        const balance = yield* chainState.getBalance(address);
        return yield* HttpServerResponse.json({ address, balance });
      }),
    ),

    HttpRouter.get(
      "/internal/markets",
      Effect.gen(function* () {
        const markets = yield* chainState.getMarkets;
        return yield* HttpServerResponse.json(markets);
      }),
    ),

    HttpRouter.get(
      "/internal/market/:id",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams);
        const market = yield* chainState.getMarket(id);
        if (!market) return yield* HttpServerResponse.json({ error: "Not found" }, { status: 404 });
        const pool = yield* chainState.getPool(id);
        return yield* HttpServerResponse.json({ market, pool });
      }),
    ),

    HttpRouter.get(
      "/internal/positions/:address",
      Effect.gen(function* () {
        const { address } = yield* HttpRouter.schemaPathParams(AddressParams);
        const positions = yield* chainState.getPositions(address);
        return yield* HttpServerResponse.json(positions);
      }),
    ),

    HttpRouter.post(
      "/internal/transaction",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(Schema.Any);
        yield* mempool.add(body as Transaction);
        return yield* HttpServerResponse.json({ accepted: true });
      }).pipe(
        Effect.catchTag("ValidationError", (e) =>
          HttpServerResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 }),
        ),
      ),
    ),

    HttpRouter.post(
      "/internal/distribute",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(DistributeBody);
        const tx = makeSystemTx(
          { type: "Distribute", to: body.recipient, amount: body.amount, memo: body.reason },
          keys,
        );
        yield* mempool.add(tx);
        return yield* HttpServerResponse.json({ accepted: true });
      }),
    ),

    HttpRouter.post(
      "/internal/create-market",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CreateMarketBody);
        const tx = makeSystemTx(
          {
            type: "CreateMarket",
            id: body.id,
            name: body.name,
            outcomes: body.outcomes,
            closesAt: body.closesAt,
            seedAmount: body.seedAmount,
          },
          keys,
        );
        yield* mempool.add(tx);
        return yield* HttpServerResponse.json({ accepted: true });
      }).pipe(
        Effect.catchTag("ValidationError", (e) =>
          HttpServerResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 }),
        ),
      ),
    ),

    HttpRouter.get(
      "/internal/events",
      Effect.gen(function* () {
        const stream = yield* eventBus.subscribe;
        const sseStream = stream.pipe(
          Stream.map((event) =>
            new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          ),
        );
        return HttpServerResponse.stream(sseStream, {
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }),
    ),
  );
});
```

**`packages/node/tests/helpers.ts`** — test infrastructure:

```typescript
import { Layer, Effect } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpServer } from "@effect/platform";
import { generateKeyPair } from "@wpm/shared";
import { ChainState } from "../src/chain-state.js";
import { EventBus } from "../src/event-bus.js";
import { Persistence } from "../src/persistence.js";
import { Mempool } from "../src/mempool.js";
import { Keys } from "../src/keys.js";
import { createGenesisBlock } from "../src/genesis.js";
import { makeRouter } from "../src/router.js";

// Two key pairs: node (PoA/treasury) and user (for bets)
export const testKeys = {
  node: generateKeyPair(),
  user: generateKeyPair(),
};

const KeysTest = Layer.succeed(Keys, {
  poaPublicKey: testKeys.node.publicKey,
  poaPrivateKey: testKeys.node.privateKey,
});

const NodeTestServices = Layer.mergeAll(
  ChainState.Live,
  EventBus.Live,
  Persistence.Test,
  KeysTest,
).pipe(Layer.provideMerge(Mempool.Live));

export const NodeTestLayer = NodeTestServices.pipe(Layer.provideMerge(NodeHttpServer.layerTest));

export const serveNodeForTest = Effect.gen(function* () {
  const chainState = yield* ChainState;
  const keys = yield* Keys;
  const genesis = createGenesisBlock(keys);
  yield* chainState.applyBlock(genesis);
  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect());
});

export { produceBlock } from "../src/producer.js";
```

---

## Cycle 3 — API Integration

One test that exercises the API's enrichment pipeline and bet flow using a stateful mock for the NodeClient boundary. Covers price/multiplier computation, mathematical consistency, bet submission, and odds shifting through the API layer.

---

### Test

```typescript
// packages/api/tests/api.test.ts
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeClient } from "../src/node-client.js";
import { UserKeys } from "../src/user-keys.js";
import { makeRouter } from "../src/router.js";
import { calculateBuy } from "@wpm/shared";

function makeStatefulMock() {
  const basePool = { marketId: "m1", sharesA: 1000, sharesB: 1000, k: 1_000_000, liquidity: 1000 };
  let pool = { ...basePool };
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
          pool = calculateBuy(pool, tx.outcome, tx.amount).newPool;
        }
      }),
    distribute: () => Effect.void,
    getMarkets: Effect.sync(() => [{ market, pool }]),
    getMarket: () => Effect.sync(() => ({ market, pool })),
    getBalance: () => Effect.succeed(100_000),
    health: Effect.succeed(true),
    eventStream: Effect.succeed(Stream.empty),
  });
}

describe("API", () => {
  it.scoped("enrichment and bet flow: prices, multipliers, bet, odds shift", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect());
      const client = yield* HttpClient.HttpClient;

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

      // -- POST /api/bet: place bet on outcome A --
      const betRes = yield* HttpClientRequest.post("/api/bet").pipe(
        HttpClientRequest.bodyUnsafeJson({ marketId: "m1", outcome: "A", amount: 100 }),
        client.execute,
      );
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(makeStatefulMock(), UserKeys.Live).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    ),
  );
});
```

### Implementation

**`packages/api/src/errors.ts`**:

```typescript
import { Data } from "effect";

export class NodeClientError extends Data.TaggedError("NodeClientError")<{
  readonly message: string;
}> {}
```

**`packages/api/src/node-client.ts`** — typed HTTP client wrapping calls to node:

```typescript
import { Context, Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { Transaction, Market, AMMPool, TradeExecutedEvent } from "@wpm/shared";
import { NodeClientError } from "./errors.js";

export class NodeClient extends Context.Tag("NodeClient")<
  NodeClient,
  {
    readonly submitTransaction: (tx: Transaction) => Effect.Effect<void, NodeClientError>;
    readonly distribute: (
      recipient: string,
      amount: number,
      reason: string,
    ) => Effect.Effect<void, NodeClientError>;
    readonly getMarkets: Effect.Effect<Array<{ market: Market; pool: AMMPool }>, NodeClientError>;
    readonly getMarket: (
      id: string,
    ) => Effect.Effect<{ market: Market; pool: AMMPool } | null, NodeClientError>;
    readonly getBalance: (address: string) => Effect.Effect<number, NodeClientError>;
    readonly health: Effect.Effect<boolean>;
    readonly eventStream: Effect.Effect<Stream.Stream<TradeExecutedEvent>, NodeClientError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const client = baseClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost:4000")),
      );
      return {
        submitTransaction: (tx) =>
          HttpClientRequest.post("/internal/transaction").pipe(
            HttpClientRequest.bodyUnsafeJson(tx),
            client.execute,
            Effect.asVoid,
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ),
        distribute: (recipient, amount, reason) =>
          HttpClientRequest.post("/internal/distribute").pipe(
            HttpClientRequest.bodyUnsafeJson({ recipient, amount, reason }),
            client.execute,
            Effect.asVoid,
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ),
        getMarkets: client.get("/internal/markets").pipe(
          Effect.flatMap((res) => res.json),
          Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
          Effect.scoped,
        ) as Effect.Effect<Array<{ market: Market; pool: AMMPool }>, NodeClientError>,
        getMarket: (id) =>
          client.get(`/internal/market/${id}`).pipe(
            Effect.flatMap((res) => res.json),
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ) as Effect.Effect<{ market: Market; pool: AMMPool } | null, NodeClientError>,
        getBalance: (address) =>
          client.get(`/internal/balance/${address}`).pipe(
            Effect.flatMap((res) => res.json),
            Effect.map((body: any) => body.balance as number),
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ),
        health: client.get("/internal/health").pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
          Effect.scoped,
        ),
        eventStream: Effect.succeed(Stream.empty), // expanded in cycle 4
      };
    }),
  );
}
```

**`packages/api/src/user-keys.ts`**:

```typescript
import { Context, Effect, Layer } from "effect";
import { generateKeyPair } from "@wpm/shared";

export class UserKeys extends Context.Tag("UserKeys")<
  UserKeys,
  {
    readonly publicKey: string;
    readonly privateKey: string;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.sync(() => generateKeyPair()),
  );
}
```

**`packages/api/src/router.ts`**:

```typescript
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Schema } from "effect";
import { calculatePrices, sign, serializeTx } from "@wpm/shared";
import type { MarketWithOdds } from "@wpm/shared";
import { NodeClient } from "./node-client.js";
import { UserKeys } from "./user-keys.js";

const BetBody = Schema.Struct({
  marketId: Schema.String,
  outcome: Schema.Union(Schema.Literal("A"), Schema.Literal("B")),
  amount: Schema.Number,
});

export const makeRouter = Effect.gen(function* () {
  const nodeClient = yield* NodeClient;
  const userKeys = yield* UserKeys;

  return HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/markets",
      Effect.gen(function* () {
        const raw = yield* nodeClient.getMarkets;
        const enriched: MarketWithOdds[] = raw.map(({ market, pool }) => {
          const { priceA, priceB } = calculatePrices(pool);
          return {
            ...market,
            priceA,
            priceB,
            multiplierA: 1 / priceA,
            multiplierB: 1 / priceB,
            pool,
          };
        });
        return yield* HttpServerResponse.json(enriched);
      }),
    ),

    HttpRouter.post(
      "/api/bet",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(BetBody);
        const tx = {
          type: "PlaceBet" as const,
          marketId: body.marketId,
          outcome: body.outcome,
          amount: body.amount,
          submitter: userKeys.publicKey,
          timestamp: new Date().toISOString(),
          signature: "",
        };
        tx.signature = sign(serializeTx(tx as Record<string, unknown>), userKeys.privateKey);
        yield* nodeClient.submitTransaction(tx);
        return yield* HttpServerResponse.json({ success: true });
      }),
    ),
  );
});
```

---

## Cycle 4 — SSE Relay

One test that verifies the API transforms raw `trade:executed` events from the node into enriched `price:update` events for web clients. Uses a mock NodeClient that provides a pre-built SSE stream.

---

### Test

```typescript
// packages/api/tests/sse-relay.test.ts
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream, Option } from "effect";
import { HttpClient, HttpServer } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeClient } from "../src/node-client.js";
import { UserKeys } from "../src/user-keys.js";
import { makeRouter } from "../src/router.js";

const MockNodeClientWithSSE = Layer.succeed(NodeClient, {
  submitTransaction: () => Effect.void,
  distribute: () => Effect.void,
  getMarkets: Effect.succeed([]),
  getMarket: () => Effect.succeed(null),
  getBalance: () => Effect.succeed(0),
  health: Effect.succeed(true),
  eventStream: Effect.succeed(
    Stream.make({
      type: "trade:executed" as const,
      marketId: "m1",
      pool: { marketId: "m1", sharesA: 909, sharesB: 1100, k: 999_900, liquidity: 1100 },
    }),
  ),
});

const SSETestLayer = Layer.mergeAll(MockNodeClientWithSSE, UserKeys.Live).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
);

describe("API SSE Relay", () => {
  it.scoped("transforms trade:executed into price:update with enriched fields", () =>
    Effect.gen(function* () {
      const router = yield* makeRouter;
      yield* router.pipe(HttpServer.serveEffect());
      const client = yield* HttpClient.HttpClient;

      const events = yield* client.get("/events/stream").pipe(
        Effect.flatMap((res) =>
          res.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapAccum("", (buffer, line) => {
              if (line.startsWith("data: ")) return [buffer + line.slice(6), undefined];
              if (line === "" && buffer !== "") return ["", buffer];
              return [buffer, undefined];
            }),
            Stream.filterMap(Option.fromNullable),
            Stream.map((s) => JSON.parse(s)),
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      expect(events.length).toBe(1);
      const event = events[0];
      expect(event.type).toBe("price:update");
      expect(event.marketId).toBe("m1");
      expect(event.priceA).toBeGreaterThan(0.5);
      expect(event.multiplierA).toBeCloseTo(1 / event.priceA, 4);
      expect(event.multiplierB).toBeCloseTo(1 / event.priceB, 4);
    }).pipe(Effect.provide(SSETestLayer)),
  );
});
```

### Implementation

**Complete `eventStream` in `packages/api/src/node-client.ts` Live:**

```typescript
eventStream: client.get("/internal/events").pipe(
  Effect.map((res) => res.stream.pipe(
    Stream.decodeText(), Stream.splitLines,
    Stream.mapAccum("", (buffer, line) => {
      if (line.startsWith("data: ")) return [buffer + line.slice(6), undefined]
      if (line === "" && buffer !== "") return ["", buffer]
      return [buffer, undefined]
    }),
    Stream.filterMap(Option.fromNullable),
    Stream.map((s) => JSON.parse(s) as TradeExecutedEvent),
  )),
  Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
),
```

**Add SSE relay endpoint to `packages/api/src/router.ts`:**

```typescript
import { Stream } from "effect"
import { calculatePrices } from "@wpm/shared"
import type { PriceUpdateEvent } from "@wpm/shared"

HttpRouter.get("/events/stream",
  Effect.gen(function*() {
    const stream = yield* nodeClient.eventStream
    const transformed = stream.pipe(
      Stream.map((event) => {
        const { priceA, priceB } = calculatePrices(event.pool)
        const update: PriceUpdateEvent = {
          type: "price:update", marketId: event.marketId,
          priceA, priceB, multiplierA: 1 / priceA, multiplierB: 1 / priceB,
        }
        return new TextEncoder().encode(`event: price:update\ndata: ${JSON.stringify(update)}\n\n`)
      }),
    )
    return HttpServerResponse.stream(transformed, {
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache", "Connection": "keep-alive" },
    })
  })
),
```

---

## After All Tests Pass

### Oracle (`packages/oracle/src/index.ts`)

A single-file script — no keys needed, no signing. Just calls the node's internal endpoint.

```typescript
import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Schedule } from "effect";

const MARKET = {
  id: "chiefs-vs-eagles-2026",
  name: "Chiefs vs Eagles - Super Bowl LXI",
  outcomes: ["Chiefs", "Eagles"],
  closesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  seedAmount: 1000,
};

const program = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  // Wait for node
  yield* client
    .get("http://localhost:4000/internal/health")
    .pipe(
      Effect.retry(Schedule.fixed("1 second").pipe(Schedule.intersect(Schedule.recurs(30)))),
      Effect.scoped,
    );

  // Check if market exists
  const res = yield* client.get("http://localhost:4000/internal/markets").pipe(Effect.scoped);
  const markets = (yield* res.json) as any[];
  if (markets.some((m: any) => m.market.id === MARKET.id)) {
    yield* Effect.logInfo("Market already exists, idling");
    return yield* Effect.never;
  }

  // Create market — node handles signing and treasury funding
  yield* HttpClientRequest.post("http://localhost:4000/internal/create-market").pipe(
    HttpClientRequest.bodyUnsafeJson(MARKET),
    client.execute,
    Effect.scoped,
  );
  yield* Effect.logInfo(`Created market: ${MARKET.name}`);
  yield* Effect.never; // idle
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeHttpClient.layer)));
```

### Node Entry Point (`packages/node/src/index.ts`)

```typescript
import { HttpServer } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Schedule } from "effect";
import { createServer } from "node:http";
import { ChainState } from "./chain-state.js";
import { EventBus } from "./event-bus.js";
import { Persistence } from "./persistence.js";
import { Mempool } from "./mempool.js";
import { Keys } from "./keys.js";
import { createGenesisBlock } from "./genesis.js";
import { makeRouter } from "./router.js";
import { produceBlock } from "./producer.js";

const HttpLive = NodeHttpServer.layer(() => createServer(), { port: 4000 });

const ServicesLive = Layer.mergeAll(
  ChainState.Live,
  EventBus.Live,
  Persistence.Live,
  Keys.Live,
).pipe(Layer.provideMerge(Mempool.Live));

const ProducerLive = Layer.scopedDiscard(
  produceBlock.pipe(
    Effect.catchAll((e) => Effect.logError("Block production error", e)),
    Effect.repeat(Schedule.fixed("5 seconds")),
    Effect.forkScoped,
  ),
);

const program = Effect.gen(function* () {
  const persistence = yield* Persistence;
  const chainState = yield* ChainState;
  const keys = yield* Keys;

  const blocks = yield* persistence.loadChain;
  if (blocks.length === 0) {
    const genesis = createGenesisBlock(keys);
    yield* persistence.appendBlock(genesis);
    yield* chainState.applyBlock(genesis);
    yield* Effect.logInfo("Created genesis block");
  } else {
    for (const block of blocks) yield* chainState.applyBlock(block);
    yield* Effect.logInfo(`Replayed ${blocks.length} blocks`);
  }

  const router = yield* makeRouter;
  yield* router.pipe(HttpServer.serveEffect());
  yield* Effect.logInfo("Node server listening on port 4000");
  yield* Effect.never;
});

const MainLive = ServicesLive.pipe(Layer.provideMerge(ProducerLive), Layer.provideMerge(HttpLive));

NodeRuntime.runMain(program.pipe(Effect.provide(MainLive)));
```

### Full System Verification (manual, in browser)

1. `cd packages/node && bun run dev`
2. `cd packages/oracle && bun run dev`
3. `cd packages/api && bun run dev`
4. `cd packages/web && bun run dev`
5. Open browser — market card at ~50/50
6. Click an outcome — bet panel appears
7. Submit a bet — odds update live via SSE, no page refresh

---

## Summary

| Cycle               | Test file                     | What it drives                                                                                         | What it verifies                                                                                                                     |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1. AMM Math         | `shared/tests/amm.test.ts`    | `initializePool`, `calculateBuy`, `calculatePrices`                                                    | Share calculation, price shift, prices sum to 1, k preserved, multi-trade invariants                                                 |
| 2. Node Integration | `node/tests/node.test.ts`     | All node services: chain-state, event-bus, persistence, mempool, validation, genesis, producer, router | Genesis balance, fund user, create market, 50/50 pool, bet placement, odds shift, balance deduction, position creation, SSE emission |
| 3. API Integration  | `api/tests/api.test.ts`       | node-client, user-keys, router (markets + bet)                                                         | Price/multiplier enrichment, multiplier=1/price, bet submission, odds shift through API                                              |
| 4. SSE Relay        | `api/tests/sse-relay.test.ts` | SSE relay endpoint, eventStream in NodeClient                                                          | trade:executed → price:update transformation, enriched fields                                                                        |

4 RED→GREEN cycles. 4 tests. 3 test files. Two keys (node + user). Each test verifies behavior through a public interface. Mocks only at system boundaries.
