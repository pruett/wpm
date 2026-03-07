import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPair, sign } from "@wpm/shared";
import type { TransferTx, CreateMarketTx } from "@wpm/shared";
import { createGenesisBlock } from "../src/genesis.js";
import { appendBlock } from "../src/persistence.js";
import { ChainState } from "../src/state.js";
import { Mempool } from "../src/mempool.js";
import { produceBlock } from "../src/producer.js";
import { startApi } from "../src/api.js";

const PORT = 0;

async function get(base: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json() };
}

describe("Complete HTTP API (FR-15)", () => {
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

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "wpm-api-"));
    chainFilePath = join(tmpDir, "chain.jsonl");

    const poaKeys = generateKeyPair();
    poaPublicKey = poaKeys.publicKey;
    poaPrivateKey = poaKeys.privateKey;

    const oracleKeys = generateKeyPair();
    oraclePublicKey = oracleKeys.publicKey;
    oraclePrivateKey = oracleKeys.privateKey;

    const userKeys = generateKeyPair();
    userPublicKey = userKeys.publicKey;

    // Genesis
    const genesis = createGenesisBlock(poaPublicKey, poaPrivateKey);
    state = new ChainState(poaPublicKey);
    appendBlock(genesis, chainFilePath);
    state.applyBlock(genesis);

    // Transfer some WPM to user
    const transferTx: TransferTx = {
      id: randomUUID(),
      type: "Transfer",
      timestamp: Date.now(),
      sender: poaPublicKey,
      recipient: userPublicKey,
      amount: 1000,
      signature: "",
    };
    transferTx.signature = sign(JSON.stringify({ ...transferTx, signature: undefined }), poaPrivateKey);

    // Create a market
    const marketTx: CreateMarketTx = {
      id: randomUUID(),
      type: "CreateMarket",
      timestamp: Date.now(),
      sender: oraclePublicKey,
      marketId: "market-1",
      sport: "NBA",
      homeTeam: "Lakers",
      awayTeam: "Celtics",
      outcomeA: "Lakers Win",
      outcomeB: "Celtics Win",
      eventStartTime: Date.now() + 86_400_000,
      seedAmount: 1000,
      externalEventId: "ext-1",
      signature: "",
    };
    marketTx.signature = sign(JSON.stringify({ ...marketTx, signature: undefined }), oraclePrivateKey);

    mempool = new Mempool(oraclePublicKey);
    mempool.add(transferTx, state);
    mempool.add(marketTx, state);
    produceBlock(state, mempool, poaPublicKey, poaPrivateKey, chainFilePath, oraclePublicKey);

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

  describe("GET /internal/state", () => {
    it("returns full chain state snapshot", async () => {
      const { status, json } = await get(baseUrl, "/internal/state");
      expect(status).toBe(200);
      const body = json as {
        blockHeight: number;
        balances: Record<string, number>;
        markets: Record<string, { marketId: string; status: string }>;
        pools: Record<string, { marketId: string; wpmLocked: number }>;
      };
      expect(body.blockHeight).toBe(2);
      expect(body.balances[userPublicKey]).toBe(1000);
      expect(body.markets["market-1"]).toBeDefined();
      expect(body.markets["market-1"].status).toBe("open");
      expect(body.pools["market-1"]).toBeDefined();
      expect(body.pools["market-1"].wpmLocked).toBe(1000);
    });
  });

  describe("GET /internal/blocks", () => {
    it("returns all blocks with default params", async () => {
      const { status, json } = await get(baseUrl, "/internal/blocks");
      expect(status).toBe(200);
      const blocks = json as { index: number }[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0].index).toBe(0);
      expect(blocks[1].index).toBe(1);
    });

    it("supports from parameter", async () => {
      const { status, json } = await get(baseUrl, "/internal/blocks?from=1");
      expect(status).toBe(200);
      const blocks = json as { index: number }[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0].index).toBe(1);
    });

    it("supports limit parameter", async () => {
      const { status, json } = await get(baseUrl, "/internal/blocks?from=0&limit=1");
      expect(status).toBe(200);
      const blocks = json as { index: number }[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0].index).toBe(0);
    });

    it("returns empty array when from exceeds chain length", async () => {
      const { status, json } = await get(baseUrl, "/internal/blocks?from=999");
      expect(status).toBe(200);
      expect(json).toEqual([]);
    });

    it("clamps limit to max 100", async () => {
      const { status, json } = await get(baseUrl, "/internal/blocks?limit=200");
      expect(status).toBe(200);
      // Should still work, just capped at 100 (we only have 2 blocks)
      const blocks = json as { index: number }[];
      expect(blocks).toHaveLength(2);
    });
  });

  describe("404 and error handling", () => {
    it("returns 404 for unknown routes", async () => {
      const { status, json } = await get(baseUrl, "/internal/nonexistent");
      expect(status).toBe(404);
      expect(json).toEqual({ error: "NOT_FOUND" });
    });

    it("returns 404 for unknown block index", async () => {
      const { status, json } = await get(baseUrl, "/internal/block/999");
      expect(status).toBe(404);
      expect((json as { error: string }).error).toBe("NOT_FOUND");
    });
  });
});
