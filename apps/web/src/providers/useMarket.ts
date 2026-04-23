"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { useRealtimeEvent } from "./RealtimeProvider";

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
