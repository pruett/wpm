"use client";

import { useState, useEffect } from "react";
import { useRealtime } from "@/lib/realtime/RealtimeProvider";

export function Balance({ initialBalance, address }: { initialBalance: number; address: string }) {
  const [balance, setBalance] = useState(initialBalance);
  const { lastEvent } = useRealtime();

  useEffect(() => {
    if (lastEvent?.type === "balance:update" && lastEvent.address === address) {
      setBalance(lastEvent.balance);
    }
  }, [lastEvent, address]);

  return (
    <span className="font-mono text-sm tabular-nums">
      {balance.toLocaleString()} <span className="text-muted-foreground">WPM</span>
    </span>
  );
}
