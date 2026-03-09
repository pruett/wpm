import type { Transaction, Block, Market, AMMPool, SharePosition } from "@wpm/shared";

// --- Response types ---

type NodeHealthResponse = {
  status: string;
  blockHeight: number;
  mempoolSize: number;
  uptimeMs: number;
};

type BalanceResponse = {
  address: string;
  balance: number;
};

type StateResponse = {
  blockHeight: number;
  balances: Record<string, number>;
  markets: Record<string, Market>;
  pools: Record<string, AMMPool>;
};

type MarketResponse = {
  market: Market;
  pool: AMMPool;
  prices: { priceA: number; priceB: number };
};

type SharesResponse = {
  address: string;
  positions: Record<string, Record<string, SharePosition>>;
};

type TxResult = {
  txId: string;
};

type NodeError = {
  code: string;
  message: string;
};

type NodeResult<T> = { ok: true; data: T } | { ok: false; error: NodeError; status: number };

// --- Client ---

const TIMEOUT_MS = 5000;

function nodeUnavailable(): NodeResult<never> {
  return {
    ok: false,
    error: { code: "NODE_UNAVAILABLE", message: "Blockchain node is unreachable" },
    status: 503,
  };
}

async function get<T>(baseUrl: string, path: string): Promise<NodeResult<T>> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json();
    if (res.ok) {
      return { ok: true, data: body as T };
    }
    return { ok: false, error: body as NodeError, status: res.status };
  } catch {
    return nodeUnavailable();
  }
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<NodeResult<T>> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json();
    if (res.ok || res.status === 202) {
      return { ok: true, data: data as T };
    }
    return { ok: false, error: data as NodeError, status: res.status };
  } catch {
    return nodeUnavailable();
  }
}

export function createNodeClient(baseUrl: string) {
  return {
    getHealth() {
      return get<NodeHealthResponse>(baseUrl, "/internal/health");
    },

    getBalance(address: string) {
      return get<BalanceResponse>(baseUrl, `/internal/balance/${encodeURIComponent(address)}`);
    },

    getState() {
      return get<StateResponse>(baseUrl, "/internal/state");
    },

    getMarket(marketId: string) {
      return get<MarketResponse>(baseUrl, `/internal/market/${encodeURIComponent(marketId)}`);
    },

    getShares(address: string) {
      return get<SharesResponse>(baseUrl, `/internal/shares/${encodeURIComponent(address)}`);
    },

    getBlocks(from = 0, limit = 50) {
      return get<Block[]>(baseUrl, `/internal/blocks?from=${from}&limit=${limit}`);
    },

    getBlock(index: number) {
      return get<Block>(baseUrl, `/internal/block/${index}`);
    },

    submitTransaction(tx: Transaction) {
      return post<TxResult>(baseUrl, "/internal/transaction", tx);
    },

    distribute(recipient: string, amount: number, reason: string) {
      return post<TxResult>(baseUrl, "/internal/distribute", { recipient, amount, reason });
    },

    referralReward(inviterAddress: string, referredUser: string) {
      return post<TxResult>(baseUrl, "/internal/referral-reward", { inviterAddress, referredUser });
    },
  };
}

export type NodeClient = ReturnType<typeof createNodeClient>;

export function getNodeUrl(): string {
  return process.env.NODE_URL ?? "http://localhost:3001";
}

export async function fetchAllBlocks(node: NodeClient): Promise<Block[]> {
  const allBlocks: Block[] = [];
  let from = 0;
  const batchSize = 100;
  while (true) {
    const result = await node.getBlocks(from, batchSize);
    if (!result.ok) break;
    allBlocks.push(...result.data);
    if (result.data.length < batchSize) break;
    from += result.data.length;
  }
  return allBlocks;
}

export type {
  NodeHealthResponse,
  BalanceResponse,
  StateResponse,
  MarketResponse,
  SharesResponse,
  TxResult,
  NodeError,
  NodeResult,
};
