"use client";

import { useBalance } from "@/lib/realtime/useBalance";

export function Balance({ initialBalance, address }: { initialBalance: number; address: string }) {
  const balance = useBalance(address, initialBalance);

  return (
    <span className="font-mono text-sm tabular-nums">
      {balance.toLocaleString()} <span className="text-muted-foreground">WPM</span>
    </span>
  );
}
