import type {
  MarketWithOdds,
  PriceUpdateEvent,
  MarketResolvedEvent,
  BalanceUpdateEvent,
} from "@wpm/shared";
import { balance } from "./balance.svelte.js";

let _markets = $state<MarketWithOdds[]>([]);
let _address = $state<string | null>(null);
let eventSource: EventSource | null = null;
let connectCount = 0;

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

export const marketStream = {
  get markets() {
    return _markets;
  },

  get address() {
    return _address;
  },

  setMarkets(markets: MarketWithOdds[]) {
    _markets = markets;
  },

  setIdentity(address: string | null, balanceValue: number | null) {
    _address = address;
    if (balanceValue !== null) {
      balance.set(balanceValue);
    }
  },

  connect() {
    connectCount += 1;
    if (eventSource) return;

    eventSource = new EventSource("/events/stream");
    eventSource.addEventListener("price:update", onPriceUpdate);
    eventSource.addEventListener("market:resolved", onMarketResolved);
    eventSource.addEventListener("balance:update", onBalanceUpdate);
  },

  disconnect() {
    connectCount = Math.max(0, connectCount - 1);
    if (connectCount > 0) return;

    if (eventSource) {
      eventSource.removeEventListener("price:update", onPriceUpdate);
      eventSource.removeEventListener("market:resolved", onMarketResolved);
      eventSource.removeEventListener("balance:update", onBalanceUpdate);
      eventSource.close();
      eventSource = null;
    }
  },
};
