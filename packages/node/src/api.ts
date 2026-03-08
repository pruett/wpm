import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { sign, calculatePrices } from "@wpm/shared";
import type { Transaction, DistributeTx, ReferralTx } from "@wpm/shared";
import { validateReferral } from "./validation.js";
import type { ChainState } from "./state.js";
import type { Mempool } from "./mempool.js";
import type { EventBus } from "./events.js";

const startTime = Date.now();

function parseJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function matchRoute(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function startApi(
  state: ChainState,
  mempool: Mempool,
  keys: { poaPublicKey: string; poaPrivateKey: string },
  port = 3001,
  host = "0.0.0.0",
  eventBus?: EventBus,
): { server: ReturnType<typeof createServer>; close: () => Promise<void> } {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    try {
      // POST /internal/transaction
      if (method === "POST" && pathname === "/internal/transaction") {
        const body = (await parseJson(req)) as Transaction;
        const result = mempool.add(body, state);
        if (result.accepted) {
          json(res, 202, { txId: body.id });
        } else {
          json(res, 400, result.error);
        }
        return;
      }

      // POST /internal/distribute
      if (method === "POST" && pathname === "/internal/distribute") {
        const body = (await parseJson(req)) as {
          recipient: string;
          amount: number;
          reason: string;
        };
        const tx: DistributeTx = {
          id: randomUUID(),
          type: "Distribute",
          timestamp: Date.now(),
          sender: keys.poaPublicKey,
          recipient: body.recipient,
          amount: body.amount,
          reason: body.reason as DistributeTx["reason"],
          signature: "",
        };
        const signData = JSON.stringify({ ...tx, signature: undefined });
        tx.signature = sign(signData, keys.poaPrivateKey);

        const result = mempool.add(tx, state);
        if (result.accepted) {
          json(res, 202, { txId: tx.id });
        } else {
          json(res, 400, result.error);
        }
        return;
      }

      // POST /internal/referral-reward
      if (method === "POST" && pathname === "/internal/referral-reward") {
        const body = (await parseJson(req)) as {
          inviterAddress: string;
          referredUser: string;
        };
        const tx: ReferralTx = {
          id: randomUUID(),
          type: "Referral",
          timestamp: Date.now(),
          sender: keys.poaPublicKey,
          recipient: body.inviterAddress,
          amount: 5000,
          referredUser: body.referredUser,
          signature: "",
        };
        const signData = JSON.stringify({ ...tx, signature: undefined });
        tx.signature = sign(signData, keys.poaPrivateKey);

        const result = validateReferral(tx, state);
        if (result.valid) {
          const mempoolResult = mempool.addDirect(tx);
          if (mempoolResult.accepted) {
            json(res, 202, { txId: tx.id });
          } else {
            json(res, 400, mempoolResult.error);
          }
        } else {
          json(res, 400, result.error);
        }
        return;
      }

      // GET /internal/events (SSE)
      if (method === "GET" && pathname === "/internal/events") {
        if (eventBus) {
          eventBus.addClient(res);
        } else {
          json(res, 503, { error: "SSE_UNAVAILABLE", message: "Event stream not configured" });
        }
        return;
      }

      // GET /internal/state
      if (method === "GET" && pathname === "/internal/state") {
        json(res, 200, {
          blockHeight: state.chain.length,
          balances: Object.fromEntries(state.balances),
          markets: Object.fromEntries(state.markets),
          pools: Object.fromEntries(state.pools),
        });
        return;
      }

      // GET /internal/blocks
      if (method === "GET" && pathname === "/internal/blocks") {
        const from = Math.max(0, Number(url.searchParams.get("from") ?? "0") || 0);
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
        const blocks = state.chain.slice(from, from + limit);
        json(res, 200, blocks);
        return;
      }

      // GET /internal/health
      if (method === "GET" && pathname === "/internal/health") {
        json(res, 200, {
          status: "ok",
          blockHeight: state.chain.length,
          mempoolSize: mempool.size,
          uptimeMs: Date.now() - startTime,
        });
        return;
      }

      // GET /internal/balance/:address
      if (method === "GET") {
        const balanceParams = matchRoute(pathname, "/internal/balance/:address");
        if (balanceParams) {
          const address = decodeURIComponent(balanceParams.address);
          json(res, 200, {
            address,
            balance: state.getBalance(address),
          });
          return;
        }
      }

      // GET /internal/block/:index
      if (method === "GET") {
        const blockParams = matchRoute(pathname, "/internal/block/:index");
        if (blockParams) {
          const index = Number(blockParams.index);
          if (!Number.isInteger(index) || index < 0) {
            json(res, 400, { error: "INVALID_INDEX", message: "Block index must be a non-negative integer" });
            return;
          }
          const block = state.chain[index];
          if (!block) {
            json(res, 404, { error: "NOT_FOUND", message: `Block ${index} not found` });
            return;
          }
          json(res, 200, block);
          return;
        }
      }

      // GET /internal/shares/:address
      if (method === "GET") {
        const sharesParams = matchRoute(pathname, "/internal/shares/:address");
        if (sharesParams) {
          const address = decodeURIComponent(sharesParams.address);
          const byAddress = state.sharePositions.get(address);
          const positions: Record<string, Record<string, { shares: number; costBasis: number }>> = {};
          if (byAddress) {
            for (const [marketId, byMarket] of byAddress) {
              positions[marketId] = {};
              for (const [outcome, pos] of byMarket) {
                positions[marketId][outcome] = { shares: pos.shares, costBasis: pos.costBasis };
              }
            }
          }
          json(res, 200, { address, positions });
          return;
        }
      }

      // GET /internal/market/:id
      if (method === "GET") {
        const marketParams = matchRoute(pathname, "/internal/market/:id");
        if (marketParams) {
          const marketId = decodeURIComponent(marketParams.id);
          const market = state.markets.get(marketId);
          if (!market) {
            json(res, 404, { error: "NOT_FOUND", message: `Market ${marketId} not found` });
            return;
          }
          const pool = state.pools.get(marketId);
          const prices = pool ? calculatePrices(pool) : { priceA: 0, priceB: 0 };
          json(res, 200, { market, pool, prices });
          return;
        }
      }

      // 404 — unknown route
      json(res, 404, { error: "NOT_FOUND" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      json(res, 500, { error: "INTERNAL_ERROR", message });
    }
  });

  server.listen(port, host);

  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
