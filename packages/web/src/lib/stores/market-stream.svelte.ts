import type {
  MarketWithOdds,
  PriceUpdateEvent,
  MarketResolvedEvent,
  BalanceUpdateEvent,
} from "@wpm/shared";
import { balance } from "./balance.svelte.js";

export function createMarketStream() {
  let _markets = $state<MarketWithOdds[]>([]);
  let _address = $state<string | null>(null);
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
    if (_address && data.address === _address) {
      balance.set(data.balance);
    }
  }

  return {
    get markets() {
      return _markets;
    },

    get address() {
      return _address;
    },

    setMarkets(markets: MarketWithOdds[]) {
      _markets = markets;
    },

    connect() {
      eventSource = new EventSource("/events/stream");
      eventSource.addEventListener("price:update", onPriceUpdate);
      eventSource.addEventListener("market:resolved", onMarketResolved);
      eventSource.addEventListener("balance:update", onBalanceUpdate);

      // Fetch initial balance (proxy handles auth via session cookie)
      fetch("/api/balance")
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (body?.balance != null) balance.set(body.balance);
          if (body?.address) _address = body.address;
        })
        .catch(() => {});
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
