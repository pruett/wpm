import { connection } from "next/server";
import { getMarket } from "@/lib/data/market";
import { getPositions } from "@/lib/data/positions";
import { LiveOdds } from "@/components/live-odds";
import { BetControls } from "@/components/bet-controls";
import type { SharePosition, MarketWithOdds } from "@wpm/shared";

function formatPnl(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function PositionRow({ pos, market }: { pos: SharePosition; market: MarketWithOdds }) {
  const outcomeName = pos.outcome === "A" ? market.outcomes[0] : market.outcomes[1];
  const currentPrice = pos.outcome === "A" ? market.priceA : market.priceB;
  const currentValue = pos.shares * currentPrice;
  const pnl = currentValue - pos.costBasis;

  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-medium">
          {outcomeName}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {pos.shares.toFixed(2)} shares
        </span>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {pos.costBasis.toFixed(2)} cost
        </span>
        <span
          className={`font-mono text-xs font-medium tabular-nums ${pnl >= 0 ? "text-green-500" : "text-destructive"}`}
        >
          {formatPnl(pnl)}
        </span>
      </div>
    </div>
  );
}

export async function MarketDetail({ id, userId }: { id: string; userId?: string }) {
  await connection();
  const [market, positions] = await Promise.all([
    getMarket(id),
    userId ? getPositions(userId) : ([] as SharePosition[]),
  ]);

  const marketPositions = positions.filter((p) => p.marketId === id);

  const closesAt = new Date(market.closesAt);
  const now = new Date();
  const isClosingSoon = closesAt.getTime() - now.getTime() < 60 * 60 * 1000;
  const isClosed = closesAt.getTime() <= now.getTime();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-mono text-lg font-bold leading-snug">{market.name}</h2>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {isClosed ? (
            <span className="text-destructive">Closed</span>
          ) : isClosingSoon ? (
            <span className="text-destructive">Closing soon</span>
          ) : (
            `Closes ${closesAt.toLocaleDateString()}`
          )}
          {" \u00B7 "}
          {market.bettorCount} {market.bettorCount === 1 ? "bettor" : "bettors"}
        </p>
      </div>

      <div>
        <h3 className="mb-2 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Probabilities
        </h3>
        <LiveOdds
          marketId={market.id}
          outcomes={market.outcomes}
          initialPriceA={market.priceA}
          initialPriceB={market.priceB}
        />
      </div>

      {userId && marketPositions.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Your Position
          </h3>
          <div className="space-y-2">
            {marketPositions.map((pos) => (
              <PositionRow key={pos.outcome} pos={pos} market={market} />
            ))}
          </div>
        </div>
      )}

      {userId && !isClosed && (
        <BetControls
          marketId={market.id}
          outcomes={market.outcomes}
          priceA={market.priceA}
          priceB={market.priceB}
          multiplierA={market.multiplierA}
          multiplierB={market.multiplierB}
          positions={marketPositions}
        />
      )}

      <div>
        <h3 className="mb-2 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pool
        </h3>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm">
          <div>
            <span className="text-muted-foreground">Shares A: </span>
            <span className="tabular-nums">{market.pool.sharesA.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Shares B: </span>
            <span className="tabular-nums">{market.pool.sharesB.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Liquidity: </span>
            <span className="tabular-nums">{market.pool.liquidity.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">k: </span>
            <span className="tabular-nums">{market.pool.k.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Payouts
        </h3>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm">
          <div>
            <span className="text-muted-foreground">{market.outcomes[0]}: </span>
            <span className="tabular-nums">{market.multiplierA.toFixed(2)}x</span>
          </div>
          <div>
            <span className="text-muted-foreground">{market.outcomes[1]}: </span>
            <span className="tabular-nums">{market.multiplierB.toFixed(2)}x</span>
          </div>
        </div>
      </div>
    </div>
  );
}
