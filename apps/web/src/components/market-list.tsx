import type { MarketWithOdds } from "@wpm/shared";

import { MarketItem } from "@/components/market-item";
import { ItemGroup } from "@/components/ui/item";

export function MarketList({ markets }: { markets: MarketWithOdds[] }) {
  return (
    <ItemGroup>
      {markets.map((m) => (
        <MarketItem key={m.id} market={m} />
      ))}
    </ItemGroup>
  );
}
