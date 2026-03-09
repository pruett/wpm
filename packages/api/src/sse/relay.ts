import { calculatePrices } from "@wpm/shared/amm";
import { createNodeClient } from "../node-client";
import type { NodeClient } from "../node-client";
import { findUserByWallet, getAllUsers } from "../db/queries";

const KEEPALIVE_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type SSEClientEntry = {
  controller: ReadableStreamDefaultController;
  keepaliveTimer: ReturnType<typeof setInterval>;
};

type ParsedSSEEvent = {
  event: string;
  data: string;
};

type ClientEvent = {
  event: string;
  data: unknown;
};

// Node event data types
type TradeExecutedData = {
  marketId: string;
  outcome: string;
  sender: string;
  amount: number;
  sharesReceived: number;
  newPriceA: number;
  newPriceB: number;
};

type MarketCreatedData = {
  marketId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  eventStartTime: number;
};

type MarketResolvedData = {
  marketId: string;
  winningOutcome: string;
  finalScore: string;
};

type MarketCancelledData = {
  marketId: string;
  reason: string;
};

type BlockNewData = {
  index: number;
  hash: string;
  txCount: number;
  timestamp: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class SSERelay {
  private clients = new Map<string, SSEClientEntry>();
  private nodeUrl: string;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connected = false;
  // Buffer market IDs from resolved/cancelled events for enrichment on block:new
  private pendingSettlementMarketIds = new Set<string>();

  constructor(nodeUrl: string) {
    this.nodeUrl = nodeUrl;
  }

  private getNodeClient(): NodeClient {
    return createNodeClient(this.nodeUrl);
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();

    try {
      const res = await fetch(`${this.nodeUrl}/internal/events`, {
        signal: this.abortController.signal,
        headers: { Accept: "text/event-stream" },
      });

      if (!res.ok || !res.body) {
        throw new Error(`Node SSE returned ${res.status}`);
      }

      this.connected = true;
      this.reconnectAttempts = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE events are delimited by double newlines
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            const parsed = this.parseSSEChunk(chunk);
            if (parsed) {
              await this.processNodeEvent(parsed);
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Stream ended — reconnect
      this.connected = false;
      this.scheduleReconnect();
    } catch (err) {
      this.connected = false;
      if (this.abortController?.signal.aborted) return;
      this.scheduleReconnect();
    }
  }

  private parseSSEChunk(chunk: string): ParsedSSEEvent | null {
    let event = "";
    let data = "";

    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue; // comment (keepalive)
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        data = line.slice(6);
      }
    }

    if (!event || !data) return null;
    return { event, data };
  }

  private async processNodeEvent(parsed: ParsedSSEEvent): Promise<void> {
    let nodeData: unknown;
    try {
      nodeData = JSON.parse(parsed.data);
    } catch {
      // Invalid JSON — forward as-is
      this.broadcastRaw(parsed.event, parsed.data);
      return;
    }

    const clientEvents = await this.transformEvent(parsed.event, nodeData);
    for (const ce of clientEvents) {
      this.broadcastClientEvent(ce.event, ce.data);
    }
  }

  private async transformEvent(nodeEvent: string, data: unknown): Promise<ClientEvent[]> {
    switch (nodeEvent) {
      case "trade:executed":
        return this.transformTradeExecuted(data as TradeExecutedData);
      case "market:created":
        return [{ event: "market:created", data }];
      case "market:resolved":
        return this.transformMarketResolved(data as MarketResolvedData);
      case "market:cancelled":
        return this.transformMarketCancelled(data as MarketCancelledData);
      case "block:new":
        return this.transformBlockNew(data as BlockNewData);
      default:
        return [{ event: nodeEvent, data }];
    }
  }

  private async transformTradeExecuted(data: TradeExecutedData): Promise<ClientEvent[]> {
    const events: ClientEvent[] = [];

    // 1. price:update — prices + multipliers from trade data
    events.push({
      event: "price:update",
      data: {
        marketId: data.marketId,
        priceA: data.newPriceA,
        priceB: data.newPriceB,
        multiplierA: data.newPriceA > 0 ? round2(1 / data.newPriceA) : 0,
        multiplierB: data.newPriceB > 0 ? round2(1 / data.newPriceB) : 0,
        totalVolume: 0, // Computed in Phase 5 task 2
      },
    });

    // 2. bet:placed — enrich with userId and userName from SQLite
    let userId: string | null = null;
    let userName: string | null = null;
    try {
      const user = findUserByWallet(data.sender);
      if (user) {
        userId = user.id;
        userName = user.name;
      }
    } catch {
      // DB lookup failed — proceed without enrichment
    }

    events.push({
      event: "bet:placed",
      data: {
        marketId: data.marketId,
        userId,
        userName,
        outcome: data.outcome,
        amount: data.amount,
        sharesReceived: data.sharesReceived,
      },
    });

    // 3. balance:update — fetch current balance from node
    try {
      const node = this.getNodeClient();
      const result = await node.getBalance(data.sender);
      if (result.ok) {
        events.push({
          event: "balance:update",
          data: {
            address: data.sender,
            balance: result.data.balance,
          },
        });
      }
    } catch {
      // Node unavailable — skip balance update
    }

    return events;
  }

  private transformMarketResolved(data: MarketResolvedData): ClientEvent[] {
    // Buffer for enrichment when block:new arrives (payouts are in the same block)
    this.pendingSettlementMarketIds.add(data.marketId);
    return [
      {
        event: "market:resolved",
        data: {
          marketId: data.marketId,
          winningOutcome: data.winningOutcome,
          finalScore: data.finalScore,
        },
      },
    ];
  }

  private transformMarketCancelled(data: MarketCancelledData): ClientEvent[] {
    // Buffer for enrichment when block:new arrives (refund payouts are in the same block)
    this.pendingSettlementMarketIds.add(data.marketId);
    return [
      {
        event: "market:cancelled",
        data: {
          marketId: data.marketId,
          reason: data.reason,
        },
      },
    ];
  }

  private async transformBlockNew(data: BlockNewData): Promise<ClientEvent[]> {
    const events: ClientEvent[] = [];

    // Process pending settlements (resolved/cancelled markets generate SettlePayout txs)
    if (this.pendingSettlementMarketIds.size > 0) {
      const settlementMarketIds = new Set(this.pendingSettlementMarketIds);
      this.pendingSettlementMarketIds.clear();

      try {
        const node = this.getNodeClient();
        const blockResult = await node.getBlock(data.index);

        if (blockResult.ok) {
          const block = blockResult.data;
          const affectedAddresses = new Set<string>();

          // Emit payout:received for each SettlePayout (excluding liquidity_return)
          for (const tx of block.transactions) {
            if (tx.type === "SettlePayout" && settlementMarketIds.has(tx.marketId)) {
              if (tx.payoutType === "liquidity_return") continue;

              events.push({
                event: "payout:received",
                data: {
                  address: tx.recipient,
                  marketId: tx.marketId,
                  amount: tx.amount,
                },
              });

              affectedAddresses.add(tx.recipient);
            }
          }

          // Emit balance:update for each affected address
          for (const address of affectedAddresses) {
            const balanceResult = await node.getBalance(address);
            if (balanceResult.ok) {
              events.push({
                event: "balance:update",
                data: {
                  address,
                  balance: balanceResult.data.balance,
                },
              });
            }
          }

          // Emit leaderboard:update with full rankings
          try {
            const rankings = await this.computeLeaderboard(node);
            events.push({
              event: "leaderboard:update",
              data: { rankings },
            });
          } catch {
            // Leaderboard computation failed — skip
          }
        }
      } catch {
        // Node unavailable — skip settlement enrichment
      }
    }

    // block:new always emitted last
    events.push({
      event: "block:new",
      data: {
        blockIndex: data.index,
        timestamp: data.timestamp,
        transactionCount: data.txCount,
      },
    });

    return events;
  }

  private async computeLeaderboard(node: NodeClient): Promise<unknown[]> {
    const stateResult = await node.getState();
    if (!stateResult.ok) return [];

    const { balances, markets, pools } = stateResult.data;
    let users: ReturnType<typeof getAllUsers>;
    try {
      users = getAllUsers();
    } catch {
      return [];
    }

    const entries: {
      rank: number;
      userId: string;
      name: string;
      walletAddress: string;
      balance: number;
      positionValue: number;
      totalWpm: number;
    }[] = [];

    for (const user of users) {
      const balance = balances[user.wallet_address] ?? 0;
      let positionValue = 0;

      const sharesResult = await node.getShares(user.wallet_address);
      if (sharesResult.ok) {
        for (const [marketId, outcomeMap] of Object.entries(sharesResult.data.positions)) {
          const market = markets[marketId];
          if (!market || market.status !== "open") continue;
          const pool = pools[marketId];
          const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 };
          for (const [outcome, pos] of Object.entries(outcomeMap)) {
            if (pos.shares <= 0) continue;
            const price = outcome === "A" ? prices.priceA : prices.priceB;
            positionValue += pos.shares * price;
          }
        }
      }

      positionValue = round2(positionValue);
      const totalWpm = round2(balance + positionValue);

      entries.push({
        rank: 0,
        userId: user.id,
        name: user.name,
        walletAddress: user.wallet_address,
        balance,
        positionValue,
        totalWpm,
      });
    }

    entries.sort((a, b) => {
      if (b.totalWpm !== a.totalWpm) return b.totalWpm - a.totalWpm;
      return a.walletAddress.localeCompare(b.walletAddress);
    });

    return entries.map((e, i) => ({ ...e, rank: i + 1 }));
  }

  private scheduleReconnect(): void {
    if (this.abortController?.signal.aborted) return;

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  addClient(userId: string): ReadableStream {
    // Enforce 1 connection per user — close prior
    this.removeClient(userId);

    const stream = new ReadableStream({
      start: (controller) => {
        const keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          } catch {
            this.removeClient(userId);
          }
        }, KEEPALIVE_INTERVAL_MS);

        this.clients.set(userId, { controller, keepaliveTimer });
      },
      cancel: () => {
        this.removeClient(userId);
      },
    });

    return stream;
  }

  removeClient(userId: string): void {
    const client = this.clients.get(userId);
    if (!client) return;

    clearInterval(client.keepaliveTimer);
    try {
      client.controller.close();
    } catch {
      // already closed
    }
    this.clients.delete(userId);
  }

  private broadcastClientEvent(event: string, data: unknown): void {
    const payload = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    for (const [userId, client] of this.clients) {
      try {
        client.controller.enqueue(payload);
      } catch {
        this.removeClient(userId);
      }
    }
  }

  private broadcastRaw(event: string, data: string): void {
    const payload = new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`);

    for (const [userId, client] of this.clients) {
      try {
        client.controller.enqueue(payload);
      } catch {
        this.removeClient(userId);
      }
    }
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  close(): void {
    this.abortController?.abort();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [userId] of this.clients) {
      this.removeClient(userId);
    }

    this.connected = false;
  }
}

let relay: SSERelay | null = null;

export function createRelay(nodeUrl: string): SSERelay {
  if (relay) relay.close();
  relay = new SSERelay(nodeUrl);
  return relay;
}

export function getRelay(): SSERelay {
  if (!relay) throw new Error("SSE relay not initialized — call createRelay() first");
  return relay;
}
