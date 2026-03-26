import type { MarketWithOdds, PriceUpdateEvent, MarketResolvedEvent } from "@wpm/shared";

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
    },

    disconnect() {
      if (eventSource) {
        eventSource.removeEventListener("price:update", onPriceUpdate);
        eventSource.removeEventListener("market:resolved", onMarketResolved);
        eventSource.close();
        eventSource = null;
      }
    },
  };
}
