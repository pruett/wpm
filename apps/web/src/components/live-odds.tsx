"use client";

import { useState, useEffect } from "react";
import { useRealtime } from "@/lib/realtime/RealtimeProvider";

type LiveOddsProps = {
  marketId: string;
  outcomes: [string, string];
  initialPriceA: number;
  initialPriceB: number;
};

export function LiveOdds({ marketId, outcomes, initialPriceA, initialPriceB }: LiveOddsProps) {
  const [priceA, setPriceA] = useState(initialPriceA);
  const [priceB, setPriceB] = useState(initialPriceB);
  const { lastEvent } = useRealtime();

  useEffect(() => {
    if (lastEvent?.type === "price:update" && lastEvent.marketId === marketId) {
      setPriceA(lastEvent.priceA);
      setPriceB(lastEvent.priceB);
    }
  }, [lastEvent, marketId]);

  return (
    <div className="grid grid-cols-2 gap-2">
      <OddsBar label={outcomes[0]} price={priceA} />
      <OddsBar label={outcomes[1]} price={priceB} />
    </div>
  );
}

function OddsBar({ label, price }: { label: string; price: number }) {
  const pct = (price * 100).toFixed(0);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-sm font-bold tabular-nums">{pct}%</span>
      </div>
      <div className="h-1 w-full rounded-full bg-muted">
        <div
          className="h-1 rounded-full bg-foreground transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
