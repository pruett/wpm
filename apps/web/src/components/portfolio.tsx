import { connection } from "next/server";
import { getPositions } from "@/lib/data/positions";
import { getMarkets } from "@/lib/data/markets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MarketWithOdds, SharePosition } from "@wpm/shared";

type EnrichedPosition = SharePosition & {
  marketName: string;
  outcomeName: string;
  currentPrice: number;
  currentValue: number;
  pnl: number;
};

function enrichPositions(
  positions: SharePosition[],
  marketsById: Map<string, MarketWithOdds>,
): EnrichedPosition[] {
  return positions
    .map((pos) => {
      const market = marketsById.get(pos.marketId);
      if (!market) return null;

      const currentPrice = pos.outcome === "A" ? market.priceA : market.priceB;
      const outcomeName = pos.outcome === "A" ? market.outcomes[0] : market.outcomes[1];
      const currentValue = pos.shares * currentPrice;
      const pnl = currentValue - pos.costBasis;

      return { ...pos, marketName: market.name, outcomeName, currentPrice, currentValue, pnl };
    })
    .filter((p): p is EnrichedPosition => p !== null);
}

function formatPnl(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

export async function Portfolio({ userId }: { userId: string }) {
  await connection();
  const [positions, { markets }] = await Promise.all([getPositions(userId), getMarkets()]);

  if (positions.length === 0) {
    return (
      <section className="mt-8">
        <h2 className="mb-4 font-mono text-lg font-bold uppercase tracking-wider">Portfolio</h2>
        <p className="font-mono text-sm text-muted-foreground">
          No positions yet. Place a bet to get started.
        </p>
      </section>
    );
  }

  const marketsById = new Map(markets.map((m) => [m.id, m]));
  const enriched = enrichPositions(positions, marketsById);

  const totalValue = enriched.reduce((sum, p) => sum + p.currentValue, 0);
  const totalCost = enriched.reduce((sum, p) => sum + p.costBasis, 0);
  const totalPnl = totalValue - totalCost;

  return (
    <section className="mt-8">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="font-mono text-lg font-bold uppercase tracking-wider">Portfolio</h2>
        <div className="flex items-baseline gap-4 font-mono text-sm">
          <span className="text-muted-foreground">
            Value <span className="tabular-nums text-foreground">{totalValue.toFixed(2)}</span>
          </span>
          <span className={totalPnl >= 0 ? "text-green-500" : "text-destructive"}>
            <span className="tabular-nums">{formatPnl(totalPnl)}</span>
          </span>
        </div>
      </div>

      <div className="space-y-2">
        {enriched.map((pos) => (
          <Card key={`${pos.marketId}-${pos.outcome}`}>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="font-mono text-sm font-bold leading-snug">
                {pos.marketName}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-medium">
                    {pos.outcomeName}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {pos.shares.toFixed(2)} shares
                  </span>
                </div>
                <div className="flex items-baseline gap-4 text-right">
                  <div className="font-mono text-xs text-muted-foreground">
                    <span className="tabular-nums">{pos.costBasis.toFixed(2)}</span>
                    <span className="ml-1">cost</span>
                  </div>
                  <div className="font-mono text-xs">
                    <span className="tabular-nums">{pos.currentValue.toFixed(2)}</span>
                    <span className="ml-1 text-muted-foreground">val</span>
                  </div>
                  <span
                    className={`font-mono text-xs font-medium tabular-nums ${pos.pnl >= 0 ? "text-green-500" : "text-destructive"}`}
                  >
                    {formatPnl(pos.pnl)}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
