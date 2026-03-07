import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Transaction } from "@wpm/shared";
import type { ChainState } from "./state.js";
import type { Mempool } from "./mempool.js";

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
  port = 3001,
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

      // 404 — unknown route
      json(res, 404, { error: "NOT_FOUND" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      json(res, 500, { error: "INTERNAL_ERROR", message });
    }
  });

  server.listen(port);

  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
