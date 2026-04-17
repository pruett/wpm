"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "./RealtimeProvider";

// Subscribes the current route to balance events for the given user.
// Matching events invalidate the cached `viewer:<id>` reads (balance,
// positions) via router.refresh().
export function useBalance(userId: string): void {
  const router = useRouter();
  useRealtimeEvent(
    useCallback(
      (event) => {
        if (event.type === "balance:update" && event.userId === userId) {
          router.refresh();
        }
      },
      [userId, router],
    ),
  );
}
