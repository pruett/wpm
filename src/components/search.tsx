"use client";

import { SearchIcon } from "lucide-react";
import { useState, useMemo } from "react";

import { MarketList } from "@/components/market-list";
import { SportLogo } from "@/components/sport-logo";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type MarketWithOdds, type Sport, SPORTS } from "@/lib/types";

export function Search({ markets }: { markets: MarketWithOdds[] }) {
  const [query, setQuery] = useState("");
  const [sport, setSport] = useState<Sport | null>(null);

  const sportCounts = useMemo(() => {
    const counts = {} as Record<Sport, number>;
    for (const s of SPORTS) counts[s] = 0;
    for (const m of markets) counts[m.sport]++;
    return counts;
  }, [markets]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return markets.filter((m) => {
      if (sport && m.sport !== sport) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q);
    });
  }, [query, sport, markets]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
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
        <ToggleGroup
          value={sport ? [sport] : []}
          onValueChange={(vals) => setSport((vals[0] as Sport | undefined) ?? null)}
          spacing={2}
          variant="outline"
          aria-label="Filter by sport"
        >
          {SPORTS.map((s) => (
            <ToggleGroupItem key={s} value={s} variant="outline" disabled={sportCounts[s] === 0}>
              <SportLogo sport={s} size={16} />
              <span className="uppercase">{s}</span>
              <span className="ml-0.5 text-muted-foreground">{sportCounts[s]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {query || sport ? "No markets match your filters." : "No active markets."}
        </p>
      ) : (
        <MarketList markets={filtered} />
      )}
    </div>
  );
}
