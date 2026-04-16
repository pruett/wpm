"use client";

import Link from "next/link";
import { useMarket } from "@/lib/realtime/useMarket";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import type { MarketWithOdds } from "@wpm/shared";

export function MarketItem({ market }: { market: MarketWithOdds }) {
  const { priceA, priceB } = useMarket(market.id, {
    priceA: market.priceA,
    priceB: market.priceB,
    multiplierA: market.multiplierA,
    multiplierB: market.multiplierB,
  });

  const pctA = (priceA * 100).toFixed(0);
  const pctB = (priceB * 100).toFixed(0);
  const closesAt = new Date(market.closesAt);

  return (
    <Item
      variant="outline"
      role="listitem"
      render={
        <Link href={`/market/${market.id}`}>
          {market.leagueLogo && (
            <ItemMedia variant="image">
              <img
                src={market.leagueLogo}
                alt=""
                width={32}
                height={32}
                className="object-contain"
              />
            </ItemMedia>
          )}
          <ItemContent>
            <ItemTitle className="line-clamp-1">{market.name}</ItemTitle>
            <ItemDescription>
              {market.outcomes[0]} vs {market.outcomes[1]}
            </ItemDescription>
          </ItemContent>
          <ItemContent className="flex-none text-center">
            <ItemTitle className="font-mono tabular-nums">
              {pctA}% &ndash; {pctB}%
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
