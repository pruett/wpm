import type { PriceUpdateEvent, MarketResolvedEvent, BalanceUpdateEvent } from "@wpm/shared";

export type RealtimeEvent = PriceUpdateEvent | MarketResolvedEvent | BalanceUpdateEvent;

const EVENT_NAME = "realtime";

// Pin to globalThis so HMR in dev and multiple import paths share one emitter.
// In-memory only — won't fan out across multiple Node processes. If we ever
// scale to >1 instance, swap this module for a Redis/Postgres LISTEN backend.
const globalForBus = globalThis as unknown as { __wpmRealtimeBus?: EventTarget };
const bus = globalForBus.__wpmRealtimeBus ?? (globalForBus.__wpmRealtimeBus = new EventTarget());

export function publish(event: RealtimeEvent): void {
  bus.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: event }));
}

export function subscribe(handler: (event: RealtimeEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<RealtimeEvent>).detail);
  bus.addEventListener(EVENT_NAME, listener);
  return () => bus.removeEventListener(EVENT_NAME, listener);
}
