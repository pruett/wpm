import type { BetHistoryEntry } from "@/data/positions";
import type { MarketWithOdds, Sport } from "@/lib/types";

import { LiveTag } from "@/components/live-tag";
import { SportLogo } from "@/components/sport-logo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getMarkets } from "@/data/markets";
import { getBetHistory } from "@/data/positions";
import { tags } from "@/data/tags";

function formatSigned(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type OpenRow = {
  entry: BetHistoryEntry;
  value: number;
  pnl: number;
};

type ClosedRow = {
  entry: BetHistoryEntry;
  pnl: number;
};

type EventGroup<Row extends { entry: BetHistoryEntry }> = {
  eventId: string;
  eventName: string;
  sport: Sport;
  rows: Row[];
};

function groupByEvent<Row extends { entry: BetHistoryEntry }>(rows: Row[]): EventGroup<Row>[] {
  const byId = new Map<string, EventGroup<Row>>();
  for (const row of rows) {
    const { eventId, eventName, sport } = row.entry;
    const group = byId.get(eventId);
    if (group) {
      group.rows.push(row);
    } else {
      byId.set(eventId, { eventId, eventName, sport, rows: [row] });
    }
  }
  return [...byId.values()];
}

function buildOpenRow(entry: BetHistoryEntry, market: MarketWithOdds | undefined): OpenRow {
  const priceYes = market?.priceYes ?? 0;
  const value = entry.shares * priceYes;
  const pnl = value - entry.costBasis;
  return { entry, value, pnl };
}

export async function Portfolio({ userId }: { userId: string }) {
  const [history, { markets }] = await Promise.all([getBetHistory(userId), getMarkets()]);

  if (history.length === 0) {
    return (
      <section className="mt-8">
        <LiveTag tag={tags.viewer(userId)} />
        <h2 className="mb-4 font-mono text-lg font-bold tracking-wider uppercase">Bets</h2>
        <p className="font-mono text-sm text-muted-foreground">
          No bets yet. Place a bet to get started.
        </p>
      </section>
    );
  }

  const marketsById = new Map(markets.map((m) => [m.id, m]));

  const openRows: OpenRow[] = history
    .filter((h) => h.marketStatus === "open")
    .map((h) => buildOpenRow(h, marketsById.get(h.marketId)))
    .sort((a, b) => Date.parse(a.entry.closesAt) - Date.parse(b.entry.closesAt));

  const closedRows: ClosedRow[] = history
    .filter((h) => h.marketStatus !== "open")
    .map((entry) => ({ entry, pnl: entry.settledAmount - entry.costBasis }))
    .sort((a, b) => (b.entry.resolvedAt ?? 0) - (a.entry.resolvedAt ?? 0));

  const openValue = openRows.reduce((sum, r) => sum + r.value, 0);
  const openCost = openRows.reduce((sum, r) => sum + r.entry.costBasis, 0);
  const openPnl = openValue - openCost;
  const realizedPnl = closedRows.reduce((sum, r) => sum + r.pnl, 0);

  const openGroups = groupByEvent(openRows).sort(
    (a, b) => Date.parse(a.rows[0].entry.closesAt) - Date.parse(b.rows[0].entry.closesAt),
  );
  const closedGroups = groupByEvent(closedRows).sort(
    (a, b) => (b.rows[0].entry.resolvedAt ?? 0) - (a.rows[0].entry.resolvedAt ?? 0),
  );

  return (
    <section className="mt-8 space-y-8">
      <LiveTag tag={tags.viewer(userId)} />
      {openGroups.length > 0 ? (
        <div>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-mono text-lg font-bold tracking-wider uppercase">Open</h2>
            <div className="flex items-baseline gap-4 font-mono text-sm">
              <span className="text-muted-foreground">
                Value <span className="text-foreground tabular-nums">{openValue.toFixed(2)}</span>
              </span>
              <span className={openPnl >= 0 ? "text-green-500" : "text-destructive"}>
                <span className="tabular-nums">{formatSigned(openPnl)}</span>
              </span>
            </div>
          </div>
          <div className="space-y-4">
            {openGroups.map((group) => (
              <EventGroupSection
                key={group.eventId}
                group={group}
                totalStake={group.rows.reduce((sum, r) => sum + r.entry.costBasis, 0)}
              >
                {group.rows.map((row) => (
                  <OpenCard key={row.entry.marketId} row={row} />
                ))}
              </EventGroupSection>
            ))}
          </div>
        </div>
      ) : null}

      {closedGroups.length > 0 ? (
        <div>
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-mono text-lg font-bold tracking-wider uppercase">History</h2>
            <span
              className={`font-mono text-sm ${realizedPnl >= 0 ? "text-green-500" : "text-destructive"}`}
            >
              <span className="text-muted-foreground">Realized </span>
              <span className="tabular-nums">{formatSigned(realizedPnl)}</span>
            </span>
          </div>
          <div className="space-y-4">
            {closedGroups.map((group) => (
              <EventGroupSection
                key={group.eventId}
                group={group}
                totalStake={group.rows.reduce((sum, r) => sum + r.entry.costBasis, 0)}
              >
                {group.rows.map((row) => (
                  <ClosedCard key={row.entry.marketId} row={row} />
                ))}
              </EventGroupSection>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function EventGroupSection<Row extends { entry: BetHistoryEntry }>({
  group,
  totalStake,
  children,
}: {
  group: EventGroup<Row>;
  totalStake: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <header className="flex items-baseline justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <SportLogo sport={group.sport} size={14} className="text-muted-foreground" />
          <h3 className="truncate font-mono text-sm font-semibold">{group.eventName}</h3>
          {group.rows.length > 1 ? (
            <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
              {group.rows.length} markets
            </Badge>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          Stake <span className="text-foreground tabular-nums">{totalStake.toFixed(2)}</span>
        </span>
      </header>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function OpenCard({ row }: { row: OpenRow }) {
  const { entry, value, pnl } = row;

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <SportLogo sport={entry.sport} size={16} className="mt-0.5 text-muted-foreground" />
            <CardTitle className="font-mono text-sm leading-snug font-bold">
              {entry.marketName}
            </CardTitle>
          </div>
          <Badge variant="outline" className="shrink-0 font-mono">
            Open
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-medium">YES</span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {entry.shares.toFixed(2)} shares
            </span>
          </div>
          <div className="font-mono text-xs">
            <span className="tabular-nums">{value.toFixed(2)}</span>
            <span className="ml-1 text-muted-foreground">val</span>
          </div>
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-2 font-mono text-xs">
          <span className="text-muted-foreground">
            Cost <span className="text-foreground tabular-nums">{entry.costBasis.toFixed(2)}</span>
          </span>
          <span
            className={`font-medium tabular-nums ${pnl >= 0 ? "text-green-500" : "text-destructive"}`}
          >
            {formatSigned(pnl)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function ClosedCard({ row }: { row: ClosedRow }) {
  const { entry, pnl } = row;
  const isCancelled = entry.marketStatus === "cancelled";
  const won = !isCancelled && entry.resolvedAs === "yes";

  let statusBadge: { label: string; variant: "default" | "destructive" | "secondary" };
  let legClass: string;
  if (isCancelled) {
    statusBadge = { label: "Refunded", variant: "secondary" };
    legClass = "bg-muted";
  } else if (won) {
    statusBadge = { label: "Won · YES", variant: "default" };
    legClass = "bg-green-500/15 text-green-500";
  } else {
    statusBadge = { label: "Lost · NO won", variant: "destructive" };
    legClass = "bg-destructive/10 text-destructive";
  }

  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <SportLogo sport={entry.sport} size={16} className="mt-0.5 text-muted-foreground" />
            <CardTitle className="font-mono text-sm leading-snug font-bold">
              {entry.marketName}
            </CardTitle>
          </div>
          <Badge variant={statusBadge.variant} className="shrink-0 font-mono">
            {statusBadge.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={`rounded px-2 py-0.5 font-mono text-xs font-medium ${legClass}`}>
              YES
            </span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {entry.shares.toFixed(2)} shares
            </span>
          </div>
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-2 font-mono text-xs">
          <div className="flex items-baseline gap-3 text-muted-foreground">
            <span>
              Cost{" "}
              <span className="text-foreground tabular-nums">{entry.costBasis.toFixed(2)}</span>
            </span>
            <span>
              Paid{" "}
              <span className="text-foreground tabular-nums">{entry.settledAmount.toFixed(2)}</span>
            </span>
            {entry.resolvedAt ? (
              <span className="hidden sm:inline">{formatDate(entry.resolvedAt)}</span>
            ) : null}
          </div>
          <span
            className={`font-medium tabular-nums ${pnl >= 0 ? "text-green-500" : "text-destructive"}`}
          >
            {formatSigned(pnl)}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
