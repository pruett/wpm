"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "./RealtimeProvider";

// Subscribes the current route to market price/resolution events. Matching
// events trigger router.refresh(), which re-runs `getMarket` / `getMarkets`
// against now-invalidated `market:<id>` cache tags. Render fresh prop values
// directly — no local state to drift from the RSC cache.
export function useMarket(marketId: string): void {
  const router = useRouter();
  useRealtimeEvent(
    useCallback(
      (event) => {
        if (event.type === "price:update" && event.marketId === marketId) {
          router.refresh();
          return;
        }
        if (event.type === "market:resolved" && event.marketId === marketId) {
          router.refresh();
        }
      },
      [marketId, router],
    ),
  );
}
