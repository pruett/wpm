import type { BetHistoryEntry } from "@/data/positions";
import type { MarketWithOdds } from "@/lib/types";

import { SportLogo } from "@/components/sport-logo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getMarkets } from "@/data/markets";
import { getBetHistory } from "@/data/positions";

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
  valueA: number;
  valueB: number;
  pnl: number;
};

type ClosedRow = {
  entry: BetHistoryEntry;
  pnl: number;
};

function buildOpenRow(entry: BetHistoryEntry, market: MarketWithOdds | undefined): OpenRow {
  const priceA = market?.priceA ?? 0;
  const priceB = market?.priceB ?? 0;
  const valueA = entry.sharesA * priceA;
  const valueB = entry.sharesB * priceB;
  const pnl = valueA + valueB - entry.costBasis;
  return { entry, valueA, valueB, pnl };
}

export async function Portfolio({ userId }: { userId: string }) {
  const [history, { markets }] = await Promise.all([getBetHistory(userId), getMarkets()]);

  if (history.length === 0) {
    return (
      <section className="mt-8">
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

  const openValue = openRows.reduce((sum, r) => sum + r.valueA + r.valueB, 0);
  const openCost = openRows.reduce((sum, r) => sum + r.entry.costBasis, 0);
  const openPnl = openValue - openCost;
  const realizedPnl = closedRows.reduce((sum, r) => sum + r.pnl, 0);

  return (
    <section className="mt-8 space-y-8">
      {openRows.length > 0 ? (
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
          <div className="space-y-2">
            {openRows.map((row) => (
              <OpenCard key={row.entry.marketId} row={row} />
            ))}
          </div>
        </div>
      ) : null}

      {closedRows.length > 0 ? (
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
          <div className="space-y-2">
            {closedRows.map((row) => (
              <ClosedCard key={row.entry.marketId} row={row} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function OpenCard({ row }: { row: OpenRow }) {
  const { entry, pnl } = row;
  const [nameA, nameB] = entry.outcomes;
  const legs: { name: string; shares: number; value: number }[] = [];
  if (entry.sharesA > 0) legs.push({ name: nameA, shares: entry.sharesA, value: row.valueA });
  if (entry.sharesB > 0) legs.push({ name: nameB, shares: entry.sharesB, value: row.valueB });

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
        <div className="space-y-1.5">
          {legs.map((leg) => (
            <div key={leg.name} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-medium">
                  {leg.name}
                </span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {leg.shares.toFixed(2)} shares
                </span>
              </div>
              <div className="font-mono text-xs">
                <span className="tabular-nums">{leg.value.toFixed(2)}</span>
                <span className="ml-1 text-muted-foreground">val</span>
              </div>
            </div>
          ))}
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
  const [nameA, nameB] = entry.outcomes;
  const isCancelled = entry.marketStatus === "cancelled";
  const won =
    !isCancelled &&
    entry.resolvedOutcome != null &&
    (entry.resolvedOutcome === "A" ? entry.sharesA > 0 : entry.sharesB > 0);

  const legs: { name: string; shares: number; isWinner: boolean }[] = [];
  if (entry.sharesA > 0) {
    legs.push({ name: nameA, shares: entry.sharesA, isWinner: entry.resolvedOutcome === "A" });
  }
  if (entry.sharesB > 0) {
    legs.push({ name: nameB, shares: entry.sharesB, isWinner: entry.resolvedOutcome === "B" });
  }

  let statusBadge: { label: string; variant: "default" | "destructive" | "secondary" };
  if (isCancelled) {
    statusBadge = { label: "Refunded", variant: "secondary" };
  } else if (won) {
    statusBadge = {
      label: `Won · ${entry.resolvedOutcome === "A" ? nameA : nameB}`,
      variant: "default",
    };
  } else {
    statusBadge = {
      label: `Lost · ${entry.resolvedOutcome === "A" ? nameA : nameB} won`,
      variant: "destructive",
    };
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
        <div className="space-y-1.5">
          {legs.map((leg) => (
            <div key={leg.name} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span
                  className={`rounded px-2 py-0.5 font-mono text-xs font-medium ${
                    leg.isWinner
                      ? "bg-green-500/15 text-green-500"
                      : isCancelled
                        ? "bg-muted"
                        : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {leg.name}
                </span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {leg.shares.toFixed(2)} shares
                </span>
              </div>
            </div>
          ))}
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
