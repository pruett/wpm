import Link from "next/link";

import type { MarketWithOdds } from "@/lib/types";

import { SportLogo } from "@/components/sport-logo";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";

export function MarketItem({ market }: { market: MarketWithOdds }) {
  const pctYes = (market.priceYes * 100).toFixed(0);
  const pctNo = ((1 - market.priceYes) * 100).toFixed(0);
  const closesAt = new Date(market.closesAt);

  return (
    <Item
      variant="outline"
      role="listitem"
      render={
        <Link href={market.eventId ? `/event/${market.eventId}` : "#"}>
          <SportLogo sport={market.sport} className="text-muted-foreground" />
          <ItemContent>
            <ItemTitle className="line-clamp-1">{market.name}</ItemTitle>
            <ItemDescription>YES vs NO</ItemDescription>
          </ItemContent>
          <ItemContent className="flex-none text-center">
            <ItemTitle className="font-mono tabular-nums">
              {pctYes}% &ndash; {pctNo}%
            </ItemTitle>
            <ItemDescription>
              {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"} &middot;{" "}
              {formatCloseTime(closesAt)}
            </ItemDescription>
          </ItemContent>
        </Link>
      }
    />
  );
}

function formatCloseTime(date: Date): string {
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  if (diff <= 0) return "Closed";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}
