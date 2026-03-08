import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { generateKeyPair, sign } from "@wpm/shared";
import type { CreateMarketTx, AMMPool, Market } from "@wpm/shared";
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

describe("CreateMarket transaction (FR-7)", () => {
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

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-create-market-"));
    chainFilePath = join(tmpDir, "chain.jsonl");

    const poaKeys = generateKeyPair();
    poaPublicKey = poaKeys.publicKey;
    poaPrivateKey = poaKeys.privateKey;

    const oracleKeys = generateKeyPair();
    oraclePublicKey = oracleKeys.publicKey;
    oraclePrivateKey = oracleKeys.privateKey;

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
  });

  afterAll(async () => {
    await api.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates market, produces block, verifies pool at 50/50", async () => {
    const tx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      seedAmount: 1000,
    });

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
    expect(block!.transactions).toHaveLength(1);
    expect(block!.transactions[0].type).toBe("CreateMarket");

    // Verify market via API
    const { status: mStatus, json: mJson } = await get(
      baseUrl,
      `/internal/market/${encodeURIComponent(tx.marketId)}`,
    );
    expect(mStatus).toBe(200);
    const result = mJson as {
      market: Market;
      pool: AMMPool;
      prices: { priceA: number; priceB: number };
    };
    expect(result.market.marketId).toBe(tx.marketId);
    expect(result.market.status).toBe("open");
    expect(result.market.sport).toBe("NFL");
    expect(result.pool.sharesA).toBe(500);
    expect(result.pool.sharesB).toBe(500);
    expect(result.pool.k).toBe(250_000);
    expect(result.pool.wpmLocked).toBe(1000);
    expect(result.prices.priceA).toBeCloseTo(0.5, 4);
    expect(result.prices.priceB).toBeCloseTo(0.5, 4);

    // Verify treasury was debited
    const { json: treasuryJson } = await get(
      baseUrl,
      `/internal/balance/${encodeURIComponent(poaPublicKey)}`,
    );
    expect((treasuryJson as { balance: number }).balance).toBe(10_000_000 - 1000);
  });

  it("rejects CreateMarket from non-oracle sender", async () => {
    const nonOracleKeys = generateKeyPair();
    const tx = makeCreateMarketTx(nonOracleKeys.publicKey, nonOracleKeys.privateKey);

    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("UNAUTHORIZED_ORACLE");
  });

  it("rejects duplicate marketId", async () => {
    const tx1 = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey);
    await post(baseUrl, "/internal/transaction", tx1);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    // Same marketId
    const tx2 = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      marketId: tx1.marketId,
    });
    const { status, json } = await post(baseUrl, "/internal/transaction", tx2);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("DUPLICATE_MARKET");
  });

  it("rejects duplicate externalEventId", async () => {
    const eventId = `espn-${randomUUID()}`;
    const tx1 = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      externalEventId: eventId,
    });
    await post(baseUrl, "/internal/transaction", tx1);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

    const tx2 = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      externalEventId: eventId,
    });
    const { status, json } = await post(baseUrl, "/internal/transaction", tx2);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("DUPLICATE_EVENT");
  });

  it("rejects event in the past", async () => {
    const tx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      eventStartTime: Date.now() - 1000,
    });
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("EVENT_IN_PAST");
  });

  it("rejects invalid seed amount", async () => {
    const tx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      seedAmount: 0,
    });
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_SEED");
  });

  it("rejects seed amount with bad precision", async () => {
    const tx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      seedAmount: 100.123,
    });
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("INVALID_PRECISION");
  });

  it("rejects missing required fields", async () => {
    const tx = makeCreateMarketTx(oraclePublicKey, oraclePrivateKey, {
      sport: "",
    });
    const { status, json } = await post(baseUrl, "/internal/transaction", tx);
    expect(status).toBe(400);
    expect((json as { code: string }).code).toBe("MISSING_FIELD");
  });

  it("returns 404 for unknown market", async () => {
    const { status, json } = await get(baseUrl, `/internal/market/${randomUUID()}`);
    expect(status).toBe(404);
    expect((json as { error: string }).error).toBe("NOT_FOUND");
  });
});
