"use client";

import { useEffect, useRef, useState } from "react";
import type { SSEEvent } from "@/lib/realtime/RealtimeProvider";

type FeedEntry = {
  id: number;
  event: SSEEvent;
  receivedAt: Date;
};

let nextId = 0;

function formatEvent(event: SSEEvent): { label: string; detail: string } {
  switch (event.type) {
    case "price:update":
      return {
        label: "Price Update",
        detail: `Market ${event.marketId.slice(0, 8)}… — A: ${(event.priceA * 100).toFixed(1)}% B: ${(event.priceB * 100).toFixed(1)}%`,
      };
    case "market:resolved":
      return {
        label: "Market Resolved",
        detail: `Market ${event.marketId.slice(0, 8)}… — Result: ${event.result}`,
      };
    case "balance:update":
      return {
        label: "Balance Update",
        detail: `${event.userId.slice(0, 12)}… — ${event.balance.toLocaleString()} WPM`,
      };
  }
}

function typeColor(type: SSEEvent["type"]): string {
  switch (type) {
    case "price:update":
      return "text-blue-400";
    case "market:resolved":
      return "text-yellow-400";
    case "balance:update":
      return "text-green-400";
  }
}

export function SystemEventFeed() {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const handler = (e: MessageEvent) => {
      const data: SSEEvent = JSON.parse(e.data);
      setEntries((prev) =>
        [{ id: nextId++, event: data, receivedAt: new Date() }, ...prev].slice(0, 50),
      );
    };

    es.addEventListener("price:update", handler);
    es.addEventListener("market:resolved", handler);
    es.addEventListener("balance:update", handler);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-destructive"}`} />
        <span className="font-mono text-xs text-muted-foreground">
          {connected ? "Connected" : "Disconnected"}
        </span>
        {entries.length > 0 && (
          <span className="font-mono text-xs text-muted-foreground">— {entries.length} events</span>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="py-8 text-center font-mono text-sm text-muted-foreground">
          Waiting for events…
        </p>
      ) : (
        <div className="max-h-96 space-y-1 overflow-y-auto">
          {entries.map((entry) => {
            const { label, detail } = formatEvent(entry.event);
            return (
              <div
                key={entry.id}
                className="flex items-baseline gap-3 rounded px-2 py-1 font-mono text-xs hover:bg-accent/30"
              >
                <time className="shrink-0 tabular-nums text-muted-foreground">
                  {entry.receivedAt.toLocaleTimeString()}
                </time>
                <span className={`shrink-0 ${typeColor(entry.event.type)}`}>{label}</span>
                <span className="truncate text-muted-foreground">{detail}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
