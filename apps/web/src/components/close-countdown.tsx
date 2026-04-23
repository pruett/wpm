"use client";

import { useEffect, useState } from "react";

function format(closesAt: string, now: number): string {
  const diff = new Date(closesAt).getTime() - now;
  if (diff <= 0) return "Closed";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function CloseCountdown({ closesAt }: { closesAt: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums">
      {format(closesAt, now)}
    </span>
  );
}
