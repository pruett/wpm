import Link from "next/link";

import type { MarketWithOdds } from "@/lib/types";

import { LiveOdds } from "@/components/live-odds";
import { SportLogo } from "@/components/sport-logo";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function MarketCard({ market }: { market: MarketWithOdds }) {
  const closesAt = new Date(market.closesAt);
  const now = new Date();
  const isClosingSoon = closesAt.getTime() - now.getTime() < 60 * 60 * 1000;

  return (
    <Link href={`/market/${market.id}`} className="block">
      <Card className="flex flex-col transition-colors hover:border-foreground/25">
        <CardHeader className="flex flex-row items-start gap-2 pb-3">
          <SportLogo sport={market.sport} className="mt-0.5 text-muted-foreground" />
          <CardTitle className="font-mono text-sm leading-snug font-bold">{market.name}</CardTitle>
        </CardHeader>
        <CardContent className="flex-1">
          <LiveOdds outcomes={market.outcomes} priceA={market.priceA} priceB={market.priceB} />
        </CardContent>
        <CardFooter className="justify-between text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">
            {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
          </span>
          <span className={isClosingSoon ? "text-destructive" : ""}>
            {formatCloseTime(closesAt)}
          </span>
        </CardFooter>
      </Card>
    </Link>
  );
}

function formatCloseTime(date: Date): string {
  const now = new Date();
  const diff = date.getTime() - now.getTime();

  if (diff <= 0) return "Closed";

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d left`;
  }

  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}
