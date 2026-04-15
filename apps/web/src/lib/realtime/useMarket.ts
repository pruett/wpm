"use client";

import { useState, useEffect } from "react";
import { useRealtime } from "./RealtimeProvider";

type MarketPrices = {
  priceA: number;
  priceB: number;
  multiplierA: number;
  multiplierB: number;
};

export function useMarket(marketId: string, initial: MarketPrices): MarketPrices {
  const [prices, setPrices] = useState(initial);
  const { lastEvent } = useRealtime();

  useEffect(() => {
    if (lastEvent?.type === "price:update" && lastEvent.marketId === marketId) {
      setPrices({
        priceA: lastEvent.priceA,
        priceB: lastEvent.priceB,
        multiplierA: lastEvent.multiplierA,
        multiplierB: lastEvent.multiplierB,
      });
    }
  }, [lastEvent, marketId]);

  return prices;
}
