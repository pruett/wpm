import { Suspense } from "react";
import { connection } from "next/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { getMarkets } from "@/lib/data/markets";
import { ResolveForm, CancelForm, OverrideSeedForm } from "@/components/market-admin-actions";

function formatCloseTime(closesAt: string): string {
  const close = new Date(closesAt);
  const now = new Date();
  const diff = close.getTime() - now.getTime();
  if (diff <= 0) return "Closed";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    open: "bg-green-500/20 text-green-500",
    closed: "bg-yellow-500/20 text-yellow-500",
    resolved: "bg-blue-500/20 text-blue-500",
    cancelled: "bg-destructive/20 text-destructive",
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 font-mono text-xs uppercase ${colors[status] ?? "bg-muted text-muted-foreground"}`}
    >
      {status}
    </span>
  );
}

async function MarketsTable() {
  await connection();
  const { markets } = await getMarkets();

  if (markets.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center font-mono text-sm text-muted-foreground">
          No markets created yet.
        </CardContent>
      </Card>
    );
  }

  const sorted = [...markets].sort((a, b) => {
    const order = { open: 0, closed: 1, resolved: 2, cancelled: 3 };
    return (order[a.status] ?? 4) - (order[b.status] ?? 4);
  });

  return (
    <div className="space-y-4">
      <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {markets.length} {markets.length === 1 ? "market" : "markets"}
      </p>
      {sorted.map((market) => {
        const isOpen = market.status === "open";
        const isClosed = market.status === "closed";
        const isActive = isOpen || isClosed;

        return (
          <Card key={market.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="font-mono text-sm font-bold">{market.name}</CardTitle>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {market.outcomes[0]} vs {market.outcomes[1]}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {statusBadge(market.status)}
                  {isOpen && (
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatCloseTime(market.closesAt)}
                    </span>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-6 font-mono text-xs tabular-nums text-muted-foreground">
                <span>A: {(market.priceA * 100).toFixed(1)}%</span>
                <span>B: {(market.priceB * 100).toFixed(1)}%</span>
                <span>Pool: {market.pool.liquidity.toLocaleString()}</span>
                <span>Bettors: {market.bettorCount}</span>
              </div>

              {market.result && (
                <p className="font-mono text-xs">
                  Result:{" "}
                  <span className="font-bold">
                    {market.result === "A" ? market.outcomes[0] : market.outcomes[1]}
                  </span>
                </p>
              )}

              {isActive && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div>
                      <p className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                        Resolve
                      </p>
                      <ResolveForm marketId={market.id} outcomes={market.outcomes} />
                    </div>
                    <div>
                      <p className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                        Cancel
                      </p>
                      <CancelForm marketId={market.id} />
                    </div>
                    <div>
                      <p className="mb-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                        Override Seeds
                      </p>
                      <OverrideSeedForm marketId={market.id} />
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default function AdminMarketsPage() {
  return (
    <div>
      <h1 className="mb-6 font-mono text-2xl font-black uppercase tracking-wider">Markets</h1>
      <Suspense
        fallback={
          <div className="space-y-4">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-3">
                  <div className="h-4 w-48 animate-pulse rounded bg-muted" />
                </CardHeader>
                <CardContent>
                  <div className="h-16 animate-pulse rounded bg-muted" />
                </CardContent>
              </Card>
            ))}
          </div>
        }
      >
        <MarketsTable />
      </Suspense>
    </div>
  );
}
