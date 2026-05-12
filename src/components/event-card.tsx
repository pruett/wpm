import Link from "next/link";

import type { MarketWithOdds } from "@/lib/types";

import { MarketCard } from "@/components/market-card";
import { SportLogo } from "@/components/sport-logo";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { initialsForName, profileColorForeground, profileColorToHex } from "@/lib/profile";

const TOP_N = 3;

type Bettor = MarketWithOdds["bettors"][number];

export function EventCard({ eventId, markets }: { eventId: string; markets: MarketWithOdds[] }) {
  if (markets.length === 1) {
    return <MarketCard market={markets[0]} />;
  }

  const sport = markets[0].sport;
  const closesAt = new Date(markets[0].closesAt);
  const now = new Date();
  const isClosingSoon = closesAt.getTime() - now.getTime() < 60 * 60 * 1000;

  const bettors = uniqueBettors(markets);

  const isBinary = markets.length === 2;
  const sorted = [...markets].sort((a, b) => b.priceYes - a.priceYes);

  return (
    <Link href={`/event/${eventId}`} className="block">
      <Card className="flex flex-col transition-colors hover:border-foreground/25">
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <SportLogo sport={sport} className="text-muted-foreground" />
          <Badge variant="secondary" className="font-mono text-[10px]">
            {markets.length} markets
          </Badge>
        </CardHeader>
        <CardContent className="flex-1">
          {isBinary ? <BinaryRows markets={sorted} /> : <MultiRows markets={sorted} />}
        </CardContent>
        <CardFooter className="justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <BettorAvatars bettors={bettors} />
            <span className="font-mono tabular-nums">
              {bettors.length} {bettors.length === 1 ? "bettor" : "bettors"}
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

function BinaryRows({ markets }: { markets: MarketWithOdds[] }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {markets.map((m) => (
        <ChildTile key={m.id} market={m} />
      ))}
    </div>
  );
}

function MultiRows({ markets }: { markets: MarketWithOdds[] }) {
  const visible = markets.slice(0, TOP_N);
  const overflow = markets.length - visible.length;
  return (
    <div className="flex flex-col gap-2">
      {visible.map((m) => (
        <ChildRow key={m.id} market={m} />
      ))}
      {overflow > 0 ? (
        <span className="font-mono text-[11px] text-muted-foreground">+{overflow} more</span>
      ) : null}
    </div>
  );
}

function ChildTile({ market }: { market: MarketWithOdds }) {
  const pct = Math.round(market.priceYes * 100);
  return (
    <div className="flex flex-col gap-1 rounded-md border p-2">
      <span className="truncate font-mono text-xs leading-tight font-bold">{market.name}</span>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm font-bold tabular-nums">{pct}%</span>
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
          {market.multiplierYes.toFixed(2)}x
        </span>
      </div>
    </div>
  );
}

function ChildRow({ market }: { market: MarketWithOdds }) {
  const pct = Math.round(market.priceYes * 100);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate font-mono text-xs font-bold">{market.name}</span>
      <span className="font-mono text-xs font-bold tabular-nums">{pct}%</span>
    </div>
  );
}

function uniqueBettors(markets: MarketWithOdds[]): Bettor[] {
  const seen = new Map<string, Bettor>();
  for (const m of markets) {
    for (const b of m.bettors) {
      if (!seen.has(b.id)) seen.set(b.id, b);
    }
  }
  return [...seen.values()];
}

function BettorAvatars({ bettors }: { bettors: Bettor[] }) {
  if (bettors.length === 0) return null;

  const visibleBettors = bettors.slice(0, 5);
  const overflowCount = bettors.length - visibleBettors.length;

  return (
    <AvatarGroup aria-label="Event bettors">
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
