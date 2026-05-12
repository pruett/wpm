import type { MarketWithOdds } from "@/lib/types";

import { EventCard } from "@/components/event-card";
import { MarketCard } from "@/components/market-card";

type EventGroup = { eventId: string; markets: MarketWithOdds[] };

function groupByEvent(markets: MarketWithOdds[]): {
  grouped: EventGroup[];
  unattached: MarketWithOdds[];
} {
  const byEvent = new Map<string, MarketWithOdds[]>();
  const unattached: MarketWithOdds[] = [];
  for (const m of markets) {
    if (m.eventId === null) {
      unattached.push(m);
      continue;
    }
    const list = byEvent.get(m.eventId) ?? [];
    list.push(m);
    byEvent.set(m.eventId, list);
  }
  const grouped: EventGroup[] = [...byEvent.entries()].map(([eventId, markets]) => ({
    eventId,
    markets,
  }));
  return { grouped, unattached };
}

export function MarketList({ markets }: { markets: MarketWithOdds[] }) {
  const { grouped, unattached } = groupByEvent(markets);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {grouped.map((g) => (
        <EventCard key={g.eventId} eventId={g.eventId} markets={g.markets} />
      ))}
      {unattached.map((m) => (
        <MarketCard key={m.id} market={m} />
      ))}
    </div>
  );
}
