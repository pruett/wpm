"use client";

import { useRealtime } from "@/lib/realtime/RealtimeProvider";

export function LiveTicker() {
  const { lastEvent, connected } = useRealtime();

  return (
    <div>
      <p>Stream: {connected ? "connected" : "disconnected"}</p>
      {lastEvent && <pre>{JSON.stringify(lastEvent, null, 2)}</pre>}
    </div>
  );
}
