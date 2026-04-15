import { connection } from "next/server";
import { getMarket } from "@/lib/data/market";
import { LiveOdds } from "@/components/live-odds";

export async function MarketDetail({ id }: { id: string }) {
  await connection();
  const market = await getMarket(id);

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
