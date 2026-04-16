import { ItemGroup } from "@/components/ui/item";
import { MarketItem } from "@/components/market-item";
import type { MarketWithOdds } from "@wpm/shared";

export function MarketList({ markets }: { markets: MarketWithOdds[] }) {
  return (
    <ItemGroup>
      {markets.map((m) => (
        <MarketItem key={m.id} market={m} />
      ))}
    </ItemGroup>
  );
}
