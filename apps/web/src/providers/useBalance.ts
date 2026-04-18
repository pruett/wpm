"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useRealtimeEvent } from "./RealtimeProvider";

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
