"use client";

import { useBalance } from "@/lib/realtime/useBalance";

export function Balance({ initialBalance, userId }: { initialBalance: number; userId: string }) {
  const balance = useBalance(userId, initialBalance);

  return (
    <span className="font-mono text-sm tabular-nums">
      {balance.toLocaleString()} <span className="text-muted-foreground">WPM</span>
    </span>
  );
}
