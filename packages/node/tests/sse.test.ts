import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, sign } from "@wpm/shared";
import type {
  TransferTx,
  CreateMarketTx,
  PlaceBetTx,
  ResolveMarketTx,
  CancelMarketTx,
} from "@wpm/shared";
import { createGenesisBlock } from "../src/genesis.js";
import { appendBlock } from "../src/persistence.js";
import { ChainState } from "../src/state.js";
import { Mempool } from "../src/mempool.js";
import { produceBlock } from "../src/producer.js";
import { startApi } from "../src/api.js";
import { EventBus } from "../src/events.js";
import http from "node:http";

const PORT = 0;

function collectSSE(
  baseUrl: string,
  maxEvents: number,
  timeoutMs = 5000,
): Promise<Array<{ event: string; data: string }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: string }> = [];
    const url = new URL("/internal/events", baseUrl);

    const req = http.get(url, (res) => {
      let currentEvent = "";
      let currentData = "";

      res.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" && currentEvent) {
            events.push({ event: currentEvent, data: currentData });
            currentEvent = "";
            currentData = "";
            if (events.length >= maxEvents) {
              req.destroy();
              resolve(events);
            }
          }
        }
      });

      res.on("end", () => resolve(events));
    });

    req.on("error", (err) => {
      if (events.length > 0) {
        resolve(events);
      } else {
        reject(err);
      }
    });

    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

describe("SSE Event Stream", () => {
  let tmpDir: string;
  let chainFilePath: string;
  let state: ChainState;
  let mempool: Mempool;
  let api: ReturnType<typeof startApi>;
  let eventBus: EventBus;
  let baseUrl: string;

  let poaPublicKey: string;
  let poaPrivateKey: string;
  let oraclePublicKey: string;
  let oraclePrivateKey: string;
  let userPublicKey: string;
  let userPrivateKey: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-sse-"));
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

    const genesis = createGenesisBlock(poaPublicKey, poaPrivateKey);
    state = new ChainState(poaPublicKey);
    appendBlock(genesis, chainFilePath);
    state.applyBlock(genesis);

    mempool = new Mempool(oraclePublicKey);
    eventBus = new EventBus();
    api = startApi(state, mempool, { poaPublicKey, poaPrivateKey }, PORT, "127.0.0.1", eventBus);

    await new Promise<void>((resolve) => {
      if (api.server.listening) return resolve();
      api.server.once("listening", resolve);
    });

    const addr = api.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
    baseUrl = `http://127.0.0.1:${actualPort}`;
  });

  afterAll(async () => {
    eventBus.closeAll();
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should emit block:new event when a Transfer block is produced", async () => {
    // Fund user first
    const distTx = buildDistributeTx(poaPublicKey, poaPrivateKey, userPublicKey, 1000);
    mempool.addDirect(distTx);
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    // Connect SSE client, then produce a block
    const transferTx = buildTransferTx(userPublicKey, userPrivateKey, poaPublicKey, 10);
    mempool.add(transferTx, state);

    const eventsPromise = collectSSE(baseUrl, 1);
    // Small delay to ensure SSE client connects before block production
    await new Promise((r) => setTimeout(r, 50));
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    const events = await eventsPromise;
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("block:new");

    const data = JSON.parse(events[0].data);
    expect(data.index).toBeGreaterThan(0);
    expect(data.txCount).toBe(1);
    expect(data.hash).toBeDefined();
    expect(data.timestamp).toBeDefined();
  });

  it("should emit market:created event", async () => {
    const marketId = randomUUID();
    const tx = buildCreateMarketTx(oraclePublicKey, oraclePrivateKey, marketId);
    mempool.add(tx, state);

    const eventsPromise = collectSSE(baseUrl, 2);
    await new Promise((r) => setTimeout(r, 50));
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    const events = await eventsPromise;
    const marketEvent = events.find((e) => e.event === "market:created");
    expect(marketEvent).toBeDefined();

    const data = JSON.parse(marketEvent!.data);
    expect(data.marketId).toBe(marketId);
    expect(data.sport).toBe("NFL");
    expect(data.homeTeam).toBe("Team A");
    expect(data.awayTeam).toBe("Team B");
    expect(data.eventStartTime).toBeDefined();
  });

  it("should emit trade:executed event for PlaceBet", async () => {
    const marketId = randomUUID();
    const createTx = buildCreateMarketTx(oraclePublicKey, oraclePrivateKey, marketId);
    mempool.add(createTx, state);
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    const betTx = buildPlaceBetTx(userPublicKey, userPrivateKey, marketId, "A", 100);
    mempool.add(betTx, state);

    const eventsPromise = collectSSE(baseUrl, 2);
    await new Promise((r) => setTimeout(r, 50));
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    const events = await eventsPromise;
    const tradeEvent = events.find((e) => e.event === "trade:executed");
    expect(tradeEvent).toBeDefined();

    const data = JSON.parse(tradeEvent!.data);
    expect(data.marketId).toBe(marketId);
    expect(data.outcome).toBe("A");
    expect(data.sender).toBe(userPublicKey);
    expect(data.amount).toBe(100);
    expect(data.sharesReceived).toBeGreaterThan(0);
    expect(data.newPriceA).toBeGreaterThan(0.5);
    expect(data.newPriceB).toBeLessThan(0.5);
  });

  it("should emit market:resolved event", async () => {
    const marketId = randomUUID();
    const createTx = buildCreateMarketTx(oraclePublicKey, oraclePrivateKey, marketId);
    mempool.add(createTx, state);
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    // Move eventStartTime to the past so ResolveMarket passes EVENT_NOT_STARTED check
    const market = state.markets.get(marketId)!;
    state.markets.set(marketId, { ...market, eventStartTime: Date.now() - 1000 });

    const resolveTx = buildResolveMarketTx(oraclePublicKey, oraclePrivateKey, marketId);
    mempool.add(resolveTx, state);

    const eventsPromise = collectSSE(baseUrl, 2);
    await new Promise((r) => setTimeout(r, 50));
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    const events = await eventsPromise;
    const resolvedEvent = events.find((e) => e.event === "market:resolved");
    expect(resolvedEvent).toBeDefined();

    const data = JSON.parse(resolvedEvent!.data);
    expect(data.marketId).toBe(marketId);
    expect(data.winningOutcome).toBe("A");
    expect(data.finalScore).toBe("3-1");
  });

  it("should emit market:cancelled event", async () => {
    const marketId = randomUUID();
    const createTx = buildCreateMarketTx(oraclePublicKey, oraclePrivateKey, marketId);
    mempool.add(createTx, state);
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    const cancelTx = buildCancelMarketTx(oraclePublicKey, oraclePrivateKey, marketId);
    mempool.add(cancelTx, state);

    const eventsPromise = collectSSE(baseUrl, 2);
    await new Promise((r) => setTimeout(r, 50));
    produceBlock(
      state,
      mempool,
      poaPublicKey,
      poaPrivateKey,
      chainFilePath,
      oraclePublicKey,
      eventBus,
    );

    const events = await eventsPromise;
    const cancelledEvent = events.find((e) => e.event === "market:cancelled");
    expect(cancelledEvent).toBeDefined();

    const data = JSON.parse(cancelledEvent!.data);
    expect(data.marketId).toBe(marketId);
    expect(data.reason).toBe("Game postponed");
  });

  it("should track client count correctly", async () => {
    // Wait for any stale connections from prior tests to fully close
    const waitForCount = async (expected: number, timeoutMs = 2000) => {
      const start = Date.now();
      while (eventBus.clientCount !== expected && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await waitForCount(0, 2000);
    const baseCount = eventBus.clientCount;

    const eventsPromise = collectSSE(baseUrl, 1, 300);
    await new Promise((r) => setTimeout(r, 50));
    expect(eventBus.clientCount).toBe(baseCount + 1);

    await eventsPromise;
    // After timeout/disconnect — poll until the close event fires
    await waitForCount(baseCount, 2000);
    expect(eventBus.clientCount).toBe(baseCount);
  });
});

// --- Helpers ---

function buildTransferTx(
  sender: string,
  senderKey: string,
  recipient: string,
  amount: number,
): TransferTx {
  const tx: TransferTx = {
    id: randomUUID(),
    type: "Transfer",
    timestamp: Date.now(),
    sender,
    recipient,
    amount,
    signature: "",
  };
  tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), senderKey);
  return tx;
}

function buildDistributeTx(
  poaPublicKey: string,
  poaPrivateKey: string,
  recipient: string,
  amount: number,
) {
  const tx = {
    id: randomUUID(),
    type: "Distribute" as const,
    timestamp: Date.now(),
    sender: poaPublicKey,
    recipient,
    amount,
    reason: "manual" as const,
    signature: "",
  };
  tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), poaPrivateKey);
  return tx;
}

function buildCreateMarketTx(
  oraclePublicKey: string,
  oraclePrivateKey: string,
  marketId: string,
  eventStartTime?: number,
): CreateMarketTx {
  const tx: CreateMarketTx = {
    id: randomUUID(),
    type: "CreateMarket",
    timestamp: Date.now(),
    sender: oraclePublicKey,
    marketId,
    sport: "NFL",
    homeTeam: "Team A",
    awayTeam: "Team B",
    outcomeA: "Team A Wins",
    outcomeB: "Team B Wins",
    eventStartTime: eventStartTime ?? Date.now() + 86_400_000,
    seedAmount: 1000,
    externalEventId: randomUUID(),
    signature: "",
  };
  tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), oraclePrivateKey);
  return tx;
}

function buildPlaceBetTx(
  sender: string,
  senderKey: string,
  marketId: string,
  outcome: "A" | "B",
  amount: number,
): PlaceBetTx {
  const tx: PlaceBetTx = {
    id: randomUUID(),
    type: "PlaceBet",
    timestamp: Date.now(),
    sender,
    marketId,
    outcome,
    amount,
    signature: "",
  };
  tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), senderKey);
  return tx;
}

function buildResolveMarketTx(
  oraclePublicKey: string,
  oraclePrivateKey: string,
  marketId: string,
): ResolveMarketTx {
  const tx: ResolveMarketTx = {
    id: randomUUID(),
    type: "ResolveMarket",
    timestamp: Date.now(),
    sender: oraclePublicKey,
    marketId,
    winningOutcome: "A",
    finalScore: "3-1",
    signature: "",
  };
  tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), oraclePrivateKey);
  return tx;
}

function buildCancelMarketTx(
  oraclePublicKey: string,
  oraclePrivateKey: string,
  marketId: string,
): CancelMarketTx {
  const tx: CancelMarketTx = {
    id: randomUUID(),
    type: "CancelMarket",
    timestamp: Date.now(),
    sender: oraclePublicKey,
    marketId,
    reason: "Game postponed",
    signature: "",
  };
  tx.signature = sign(JSON.stringify({ ...tx, signature: undefined }), oraclePrivateKey);
  return tx;
}
