"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BalanceUpdateEvent, MarketResolvedEvent, PriceUpdateEvent } from "@wpm/shared";

export type SSEEvent = PriceUpdateEvent | MarketResolvedEvent | BalanceUpdateEvent;

type Subscriber = (event: SSEEvent) => void;

type RealtimeContextValue = {
  subscribe: (handler: Subscriber) => () => void;
  connected: boolean;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used inside RealtimeProvider");
  return ctx;
}

// Subscribes a handler to the shared SSE connection. The latest handler is
// always called — no re-subscribe churn when callers pass inline closures.
export function useRealtimeEvent(handler: Subscriber): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => subscribe((event) => handlerRef.current(event)), [subscribe]);
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const subscribersRef = useRef<Set<Subscriber>>(new Set());

  const subscribe = useCallback<RealtimeContextValue["subscribe"]>((handler) => {
    const set = subscribersRef.current;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/stream");

    const onOpen = () => setConnected(true);
    const onError = () => setConnected(false);
    const dispatch = (e: MessageEvent) => {
      let data: SSEEvent;
      try {
        data = JSON.parse(e.data) as SSEEvent;
      } catch {
        return;
      }
      for (const sub of subscribersRef.current) {
        try {
          sub(data);
        } catch (err) {
          console.error("realtime subscriber error", err);
        }
      }
    };

    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError);
    es.addEventListener("price:update", dispatch);
    es.addEventListener("market:resolved", dispatch);
    es.addEventListener("balance:update", dispatch);

    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError);
      es.removeEventListener("price:update", dispatch);
      es.removeEventListener("market:resolved", dispatch);
      es.removeEventListener("balance:update", dispatch);
      es.close();
    };
  }, []);

  return <RealtimeContext value={{ subscribe, connected }}>{children}</RealtimeContext>;
}
