"use client";

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { MarketList } from "@/components/market-list";
import type { MarketWithOdds } from "@wpm/shared";

export function Search({ markets }: { markets: MarketWithOdds[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return markets;
    return markets.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.outcomes[0].toLowerCase().includes(q) ||
        m.outcomes[1].toLowerCase().includes(q),
    );
  }, [query, markets]);

  return (
    <div className="space-y-4">
      <Input
        type="search"
        placeholder="Search markets…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-sm font-mono"
      />
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query ? "No markets match your search." : "No active markets."}
        </p>
      ) : (
        <MarketList markets={filtered} />
      )}
    </div>
  );
}
