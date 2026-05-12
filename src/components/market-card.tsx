import Link from "next/link";

import type { MarketWithOdds } from "@/lib/types";

import { LiveOdds } from "@/components/live-odds";
import { SportLogo } from "@/components/sport-logo";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { initialsForName, profileColorForeground, profileColorToHex } from "@/lib/profile";

export function MarketCard({ market }: { market: MarketWithOdds }) {
  const closesAt = new Date(market.closesAt);
  const now = new Date();
  const isClosingSoon = closesAt.getTime() - now.getTime() < 60 * 60 * 1000;

  return (
    <Link href={market.eventId ? `/event/${market.eventId}` : "#"} className="block">
      <Card className="flex flex-col transition-colors hover:border-foreground/25">
        <CardHeader className="flex flex-row items-start gap-2 pb-3">
          <SportLogo sport={market.sport} className="mt-0.5 text-muted-foreground" />
          <CardTitle className="font-mono text-sm leading-snug font-bold">{market.name}</CardTitle>
        </CardHeader>
        <CardContent className="flex-1">
          <LiveOdds priceYes={market.priceYes} />
        </CardContent>
        <CardFooter className="justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <BettorAvatars bettors={market.bettors} />
            <span className="font-mono tabular-nums">
              {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
            </span>
          </div>
          <span className={isClosingSoon ? "text-destructive" : ""}>
            {formatCloseTime(closesAt)}
          </span>
        </CardFooter>
      </Card>
    </Link>
  );
}

function BettorAvatars({ bettors }: { bettors: MarketWithOdds["bettors"] }) {
  if (bettors.length === 0) return null;

  const visibleBettors = bettors.slice(0, 5);
  const overflowCount = bettors.length - visibleBettors.length;

  return (
    <AvatarGroup aria-label="Market bettors">
      {visibleBettors.map((bettor) => {
        const backgroundColor = profileColorToHex(bettor.color);
        const color = profileColorForeground(bettor.color);

        return (
          <HoverCard key={bettor.id}>
            <HoverCardTrigger render={<span />}>
              <Avatar size="sm">
                <AvatarFallback
                  style={{ backgroundColor, color }}
                  className="font-mono text-[10px] font-bold text-current"
                >
                  {initialsForName(bettor.name)}
                </AvatarFallback>
              </Avatar>
            </HoverCardTrigger>
            <HoverCardContent side="top" align="start" className="w-fit px-3 py-2">
              <p className="font-medium whitespace-nowrap">{bettor.name}</p>
            </HoverCardContent>
          </HoverCard>
        );
      })}
      {overflowCount > 0 && <AvatarGroupCount>+{overflowCount}</AvatarGroupCount>}
    </AvatarGroup>
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
