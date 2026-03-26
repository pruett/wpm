import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MarketWithOdds, PriceUpdateEvent, MarketResolvedEvent } from "@wpm/shared";

// Mock EventSource before importing the module
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  simulateEvent(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners[type]?.forEach((l) => l(event));
  }
}

vi.stubGlobal("EventSource", MockEventSource);

const { createMarketStream } = await import("$lib/stores/market-stream.svelte.js");

const mockMarket: MarketWithOdds = {
  id: "market-1",
  name: "Eagles vs Chiefs",
  outcomes: ["Eagles", "Chiefs"] as [string, string],
  closesAt: "2026-02-09T23:00:00Z",
  status: "open",
  priceA: 0.55,
  priceB: 0.45,
  multiplierA: 1.82,
  multiplierB: 2.22,
  pool: {
    marketId: "market-1",
    sharesA: 4500,
    sharesB: 5500,
    k: 24750000,
    liquidity: 10000,
  },
};

describe("createMarketStream", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
  });

  it("connects to the SSE endpoint", () => {
    const stream = createMarketStream();
    stream.connect();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/events/stream");

    stream.disconnect();
  });

  it("applies price:update events to markets", () => {
    const stream = createMarketStream();
    stream.setMarkets([mockMarket]);
    stream.connect();

    const update: PriceUpdateEvent = {
      type: "price:update",
      marketId: "market-1",
      priceA: 0.65,
      priceB: 0.35,
      multiplierA: 1.54,
      multiplierB: 2.86,
    };

    const es = MockEventSource.instances[0];
    es.simulateEvent("price:update", update);

    const markets = stream.markets;
    expect(markets[0].priceA).toBe(0.65);
    expect(markets[0].priceB).toBe(0.35);
    expect(markets[0].multiplierA).toBe(1.54);
    expect(markets[0].multiplierB).toBe(2.86);

    stream.disconnect();
  });

  it("applies market:resolved events", () => {
    const stream = createMarketStream();
    stream.setMarkets([mockMarket]);
    stream.connect();

    const resolved: MarketResolvedEvent = {
      type: "market:resolved",
      marketId: "market-1",
      result: "A",
    };

    const es = MockEventSource.instances[0];
    es.simulateEvent("market:resolved", resolved);

    const markets = stream.markets;
    expect(markets[0].status).toBe("resolved");
    expect(markets[0].result).toBe("A");

    stream.disconnect();
  });

  it("ignores events for unknown market IDs", () => {
    const stream = createMarketStream();
    stream.setMarkets([mockMarket]);
    stream.connect();

    const update: PriceUpdateEvent = {
      type: "price:update",
      marketId: "unknown-market",
      priceA: 0.99,
      priceB: 0.01,
      multiplierA: 1.01,
      multiplierB: 100,
    };

    const es = MockEventSource.instances[0];
    es.simulateEvent("price:update", update);

    const markets = stream.markets;
    expect(markets[0].priceA).toBe(0.55);

    stream.disconnect();
  });

  it("closes EventSource on disconnect", () => {
    const stream = createMarketStream();
    stream.connect();

    const es = MockEventSource.instances[0];
    stream.disconnect();

    expect(es.close).toHaveBeenCalled();
  });
});
