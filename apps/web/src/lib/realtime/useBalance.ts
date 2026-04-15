"use client";

import { useState, useEffect } from "react";
import { useRealtime } from "./RealtimeProvider";

export function useBalance(address: string, initialBalance: number): number {
  const [balance, setBalance] = useState(initialBalance);
  const { lastEvent } = useRealtime();

  useEffect(() => {
    if (lastEvent?.type === "balance:update" && lastEvent.address === address) {
      setBalance(lastEvent.balance);
    }
  }, [lastEvent, address]);

  return balance;
}
