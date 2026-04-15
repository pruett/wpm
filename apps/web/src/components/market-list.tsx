import { MarketCard } from "@/components/market-card";
import type { MarketWithOdds } from "@wpm/shared";

export function MarketList({ markets }: { markets: MarketWithOdds[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {markets.map((m) => (
        <MarketCard key={m.id} market={m} />
      ))}
    </div>
  );
}
