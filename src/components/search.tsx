"use client";

import { SearchIcon } from "lucide-react";
import { useState, useMemo } from "react";

import type { MarketWithOdds } from "@/lib/types";

import { MarketList } from "@/components/market-list";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

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
      <InputGroup className="max-w-sm">
        <InputGroupInput
          type="search"
          placeholder="Search markets…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupAddon align="inline-end">{filtered.length} results</InputGroupAddon>
      </InputGroup>
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
