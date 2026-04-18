"use client";

import { useBalance } from "@/providers/useBalance";

export function Balance({ balance, userId }: { balance: number; userId: string }) {
  useBalance(userId);

  return (
    <span className="font-mono text-sm tabular-nums">
      {balance.toLocaleString()} <span className="text-muted-foreground">WPM</span>
    </span>
  );
}
