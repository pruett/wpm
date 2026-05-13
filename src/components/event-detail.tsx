import type { EventWithMarkets } from "@/data/events";
import type { SharePosition } from "@/lib/types";

import { BetControls } from "@/components/bet-controls";
import { LiveTag } from "@/components/live-tag";
import { SportLogo } from "@/components/sport-logo";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getEvent } from "@/data/events";
import { getPositions } from "@/data/positions";
import { tags } from "@/data/tags";

export async function EventDetail({ id, userId }: { id: string; userId?: string }) {
  const [event, positions] = await Promise.all([
    getEvent(id),
    userId ? getPositions(userId) : ([] as SharePosition[]),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <LiveTag tag={tags.event(id)} />
      <EventHeader event={event} />
      <Separator />
      <ol className="flex flex-col gap-6">
        {event.markets.map((child) => {
          const position = positions.find((p) => p.marketId === child.id);
          return (
            <li key={child.id} className="rounded-md border p-4">
              <LiveTag tag={tags.market(child.id)} />
              <BetControls
                market={{
                  id: child.id,
                  name: child.name,
                  status: child.status,
                  priceYes: child.priceYes,
                  multiplierYes: child.multiplierYes,
                  bettorCount: child.bettorCount,
                }}
                sport={event.sport}
                closesAt={event.closesAt}
                userId={userId}
                position={position}
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function EventHeader({ event }: { event: EventWithMarkets }) {
  const closesAt = new Date(event.closesAt);
  const diffMs = closesAt.getTime() - Date.now();
  const remaining = formatRemaining(diffMs);

  return (
    <header className="flex items-start gap-3">
      <SportLogo sport={event.sport} size={22} className="mt-1 text-muted-foreground" />
      <div className="flex flex-1 flex-col gap-2">
        <h1 className="font-mono text-lg leading-snug font-bold">{event.name}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {event.status === "terminal" ? (
            <Badge variant="secondary">Terminal</Badge>
          ) : diffMs <= 0 ? (
            <Badge variant="destructive">Closed</Badge>
          ) : diffMs < 60 * 60 * 1000 ? (
            <Badge variant="destructive">Closing in {remaining}</Badge>
          ) : (
            <Badge variant="outline">Closes in {remaining}</Badge>
          )}
          <Badge variant="secondary">
            {event.markets.length} {event.markets.length === 1 ? "market" : "markets"}
          </Badge>
        </div>
      </div>
    </header>
  );
}

function formatRemaining(diffMs: number): string {
  if (diffMs <= 0) return "closed";
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
