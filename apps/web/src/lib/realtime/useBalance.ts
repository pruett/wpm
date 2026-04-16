"use client";

import { useState, useEffect } from "react";
import { useRealtime } from "./RealtimeProvider";

export function useBalance(userId: string, initialBalance: number): number {
  const [balance, setBalance] = useState(initialBalance);
  const { lastEvent } = useRealtime();

  useEffect(() => {
    if (lastEvent?.type === "balance:update" && lastEvent.userId === userId) {
      setBalance(lastEvent.balance);
    }
  }, [lastEvent, userId]);

  return balance;
}
