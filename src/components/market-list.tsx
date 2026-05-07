import type { MarketWithOdds } from "@/lib/types";

import { MarketCard } from "@/components/market-card";

export function MarketList({ markets }: { markets: MarketWithOdds[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {markets.map((m) => (
        <MarketCard key={m.id} market={m} />
      ))}
    </div>
  );
}
