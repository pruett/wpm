"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PriceUpdateEvent, MarketResolvedEvent, BalanceUpdateEvent } from "@wpm/shared";

export type SSEEvent = PriceUpdateEvent | MarketResolvedEvent | BalanceUpdateEvent;

type RealtimeContextValue = {
  lastEvent: SSEEvent | null;
  connected: boolean;
};

const RealtimeContext = createContext<RealtimeContextValue>({
  lastEvent: null,
  connected: false,
});

export function useRealtime() {
  return useContext(RealtimeContext);
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const handler = (e: MessageEvent) => {
      const data: SSEEvent = JSON.parse(e.data);
      setLastEvent(data);
    };

    es.addEventListener("price:update", handler);
    es.addEventListener("market:resolved", handler);
    es.addEventListener("balance:update", handler);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return <RealtimeContext value={{ lastEvent, connected }}>{children}</RealtimeContext>;
}
