import type {
  MarketWithOdds,
  PriceUpdateEvent,
  MarketResolvedEvent,
  BalanceUpdateEvent,
} from "@wpm/shared";
import { auth } from "./auth.svelte.js";
import { balance } from "./balance.svelte.js";

export function createMarketStream() {
  let _markets = $state<MarketWithOdds[]>([]);
  let eventSource: EventSource | null = null;

  function onPriceUpdate(event: MessageEvent) {
    const data: PriceUpdateEvent = JSON.parse(event.data);
    _markets = _markets.map((m) =>
      m.id === data.marketId
        ? {
            ...m,
            priceA: data.priceA,
            priceB: data.priceB,
            multiplierA: data.multiplierA,
            multiplierB: data.multiplierB,
          }
        : m,
    );
  }

  function onMarketResolved(event: MessageEvent) {
    const data: MarketResolvedEvent = JSON.parse(event.data);
    _markets = _markets.map((m) =>
      m.id === data.marketId ? { ...m, status: "resolved" as const, result: data.result } : m,
    );
  }

  function onBalanceUpdate(event: MessageEvent) {
    const data: BalanceUpdateEvent = JSON.parse(event.data);
    if (data.address === auth.address) {
      balance.set(data.balance);
    }
  }

  return {
    get markets() {
      return _markets;
    },

    setMarkets(markets: MarketWithOdds[]) {
      _markets = markets;
    },

    connect() {
      eventSource = new EventSource("/events/stream");
      eventSource.addEventListener("price:update", onPriceUpdate);
      eventSource.addEventListener("market:resolved", onMarketResolved);
      eventSource.addEventListener("balance:update", onBalanceUpdate);

      // Fetch initial balance for returning users (one-time, not polling)
      if (auth.isLoggedIn) {
        fetch("/api/balance", {
          headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((body) => {
            if (body?.balance != null) balance.set(body.balance);
          })
          .catch(() => {});
      }
    },

    disconnect() {
      if (eventSource) {
        eventSource.removeEventListener("price:update", onPriceUpdate);
        eventSource.removeEventListener("market:resolved", onMarketResolved);
        eventSource.removeEventListener("balance:update", onBalanceUpdate);
        eventSource.close();
        eventSource = null;
      }
    },
  };
}
