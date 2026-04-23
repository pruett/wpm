"use client";

import { useCallback, useRef, useState } from "react";

import { useRealtime, useRealtimeEvent, type SSEEvent } from "@/providers/RealtimeProvider";

type FeedEntry = {
  id: number;
  event: SSEEvent;
  receivedAt: Date;
};

const MAX_ENTRIES = 50;

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
  const { connected } = useRealtime();
  const nextIdRef = useRef(0);

  useRealtimeEvent(
    useCallback((event) => {
      setEntries((prev) =>
        [{ id: nextIdRef.current++, event, receivedAt: new Date() }, ...prev].slice(0, MAX_ENTRIES),
      );
    }, []),
  );

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
                <time className="shrink-0 text-muted-foreground tabular-nums">
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
