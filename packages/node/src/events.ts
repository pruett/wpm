import type { ServerResponse } from "node:http";
import type { Block, AMMPool } from "@wpm/shared";
import { calculatePrices, calculateBuy, calculateSell } from "@wpm/shared";
import type { ChainState } from "./state.js";

type SSEEvent = {
  event: string;
  data: unknown;
};

type SSEClient = {
  res: ServerResponse;
  keepaliveTimer: ReturnType<typeof setInterval>;
};

const KEEPALIVE_INTERVAL_MS = 30_000;

export class EventBus {
  private clients: Set<SSEClient> = new Set();

  get clientCount(): number {
    return this.clients.size;
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const keepaliveTimer = setInterval(() => {
      res.write(": keepalive\n\n");
    }, KEEPALIVE_INTERVAL_MS);

    const client: SSEClient = { res, keepaliveTimer };
    this.clients.add(client);

    res.on("close", () => {
      clearInterval(keepaliveTimer);
      this.clients.delete(client);
    });
  }

  emit(event: SSEEvent): void {
    const payload = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of this.clients) {
      client.res.write(payload);
    }
  }

  emitBlockEvents(block: Block, stateBefore: ChainState): void {
    // Track intermediate pool state for accurate per-trade prices
    const poolSnapshots = new Map<string, AMMPool>();
    const getPool = (marketId: string): AMMPool | undefined =>
      poolSnapshots.get(marketId) ?? stateBefore.pools.get(marketId);

    for (const tx of block.transactions) {
      switch (tx.type) {
        case "CreateMarket": {
          const halfSeed = tx.seedAmount / 2;
          poolSnapshots.set(tx.marketId, {
            marketId: tx.marketId,
            sharesA: halfSeed,
            sharesB: halfSeed,
            k: halfSeed * halfSeed,
            wpmLocked: tx.seedAmount,
          });
          this.emit({
            event: "market:created",
            data: {
              marketId: tx.marketId,
              sport: tx.sport,
              homeTeam: tx.homeTeam,
              awayTeam: tx.awayTeam,
              eventStartTime: tx.eventStartTime,
            },
          });
          break;
        }
        case "ResolveMarket":
          this.emit({
            event: "market:resolved",
            data: {
              marketId: tx.marketId,
              winningOutcome: tx.winningOutcome,
              finalScore: tx.finalScore,
            },
          });
          break;
        case "CancelMarket":
          this.emit({
            event: "market:cancelled",
            data: {
              marketId: tx.marketId,
              reason: tx.reason,
            },
          });
          break;
        case "PlaceBet": {
          const pool = getPool(tx.marketId);
          if (pool) {
            const buyResult = calculateBuy(pool, tx.outcome, tx.amount);
            poolSnapshots.set(tx.marketId, buyResult.pool);
            const prices = calculatePrices(buyResult.pool);
            this.emit({
              event: "trade:executed",
              data: {
                marketId: tx.marketId,
                outcome: tx.outcome,
                sender: tx.sender,
                amount: tx.amount,
                sharesReceived: buyResult.sharesToUser,
                newPriceA: prices.priceA,
                newPriceB: prices.priceB,
              },
            });
          }
          break;
        }
        case "SellShares": {
          const pool = getPool(tx.marketId);
          if (pool) {
            const sellResult = calculateSell(pool, tx.outcome, tx.shareAmount);
            poolSnapshots.set(tx.marketId, sellResult.pool);
            const prices = calculatePrices(sellResult.pool);
            this.emit({
              event: "trade:executed",
              data: {
                marketId: tx.marketId,
                outcome: tx.outcome,
                sender: tx.sender,
                amount: sellResult.netReturn,
                sharesReceived: -tx.shareAmount,
                newPriceA: prices.priceA,
                newPriceB: prices.priceB,
              },
            });
          }
          break;
        }
      }
    }

    this.emit({
      event: "block:new",
      data: {
        index: block.index,
        hash: block.hash,
        txCount: block.transactions.length,
        timestamp: block.timestamp,
      },
    });
  }

  closeAll(): void {
    for (const client of this.clients) {
      clearInterval(client.keepaliveTimer);
      client.res.end();
    }
    this.clients.clear();
  }
}
