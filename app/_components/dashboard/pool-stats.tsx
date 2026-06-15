import { getPoolStats } from "@/app/_data/pool-stats";
import { Card, CardBody, CardHeader, CardEyebrow, CardTitle } from "@/app/_components/ui/card";
import { StatTile } from "@/app/_components/ui/stat";
import { Badge } from "@/app/_components/ui/badge";
import { Skeleton } from "@/app/_components/ui/skeleton";
import {
  formatCount,
  formatDollars,
  formatPercent,
  formatSignedDollars,
} from "@/app/_lib/format";

function Header() {
  return (
    <CardHeader>
      <div>
        <CardEyebrow>House Vitals</CardEyebrow>
        <CardTitle>The Book</CardTitle>
      </div>
      <Badge tone="gold">All-Time</Badge>
    </CardHeader>
  );
}

/** The book's vital signs — featured biggest-hit panel plus a grid of readings. */
export async function PoolStats() {
  const s = await getPoolStats();

  return (
    <Card>
      <Header />
      <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Featured: biggest hit ever, spanning two columns where there's room. */}
        <div className="relative flex flex-col justify-between gap-3 overflow-hidden rounded-xl border border-gold/25 bg-gradient-to-br from-gold/[0.08] to-transparent p-4 sm:col-span-2 lg:col-span-2">
          <div className="flex items-center justify-between">
            <span className="eyebrow text-gold/80">Biggest Hit Ever</span>
            <span className="text-lg">💰</span>
          </div>
          {s.biggestHit ? (
            <>
              <div className="nums text-4xl font-bold leading-none text-gold sm:text-5xl">
                +{formatDollars(s.biggestHit.profitCents)}
              </div>
              <p className="text-sm text-muted">
                <span className="font-semibold text-foreground">{s.biggestHit.name}</span>{" "}
                cashed{" "}
                {s.biggestHit.side === "yes" ? "on" : "against"}{" "}
                <span className="text-foreground">{s.biggestHit.outcome}</span>
                <span className="text-faint"> · {s.biggestHit.title}</span>
              </p>
            </>
          ) : (
            <>
              <div className="nums text-4xl font-bold leading-none text-muted">$0</div>
              <p className="text-sm text-muted">
                Nobody's hit a winner worth bragging about yet. Be the first.
              </p>
            </>
          )}
        </div>

        <StatTile
          label="Live / Pending"
          value={formatCount(s.openBets)}
          sub={`${formatDollars(s.atRiskCents)} at risk · ${formatCount(s.contractsInPlay)} contracts`}
          accent={s.openBets > 0 ? "win" : "muted"}
        />
        <StatTile
          label="Hit Rate"
          value={s.winRate != null ? formatPercent(s.winRate) : "—"}
          sub={s.settled > 0 ? `across ${formatCount(s.settled)} settled bets` : "no settled bets yet"}
          accent={s.winRate != null && s.winRate >= 0.5 ? "win" : "loss"}
        />
        <StatTile
          label="Average Ticket"
          value={s.avgStakeCents != null ? formatDollars(s.avgStakeCents) : "—"}
          sub="per bet placed"
        />
        <StatTile
          label="The House"
          value={formatSignedDollars(s.houseNetCents)}
          sub={
            s.houseEdge != null
              ? `${formatPercent(Math.abs(s.houseEdge))} ${s.houseNetCents >= 0 ? "edge" : "underwater"}`
              : "no action settled"
          }
          accent={s.houseNetCents >= 0 ? "win" : "loss"}
        />
      </CardBody>
    </Card>
  );
}

export function PoolStatsSkeleton() {
  return (
    <Card>
      <Header />
      <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel-2 p-4 sm:col-span-2 lg:col-span-2">
          <Skeleton className="h-2.5 w-28" />
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
