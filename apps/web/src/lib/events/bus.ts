import "server-only";
import type { PriceUpdateEvent, MarketResolvedEvent, BalanceUpdateEvent } from "@wpm/shared";

export type RealtimeEvent = PriceUpdateEvent | MarketResolvedEvent | BalanceUpdateEvent;

const EVENT_NAME = "realtime";

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
