import { getOverview } from "@/app/_data/overview";
import { Skeleton } from "@/app/_components/ui/skeleton";
import {
  formatCompactDollars,
  formatCount,
  formatDollars,
} from "@/app/_lib/format";

function Cell({
  label,
  value,
  sub,
  accent = "text-foreground",
}: {
  label: string;
  value: string;
  sub: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-5 py-5 sm:px-6">
      <span className="eyebrow">{label}</span>
      <span className={`nums text-4xl font-bold leading-none sm:text-5xl ${accent}`}>
        {value}
      </span>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}

/** The marquee: four lifetime readings across the top of the board. */
export async function HeroStats() {
  const o = await getOverview();
  const settledNote =
    o.settledBets > 0
      ? `${formatCount(o.wins)}W · ${formatCount(o.losses)}L settled`
      : "nothing settled yet";

  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-panel/70 backdrop-blur-sm sm:grid-cols-4 sm:divide-y-0">
      <Cell
        label="Total Bets"
        value={formatCount(o.totalBets)}
        sub={settledNote}
        accent="text-gold"
      />
      <Cell
        label="Total Wagered"
        value={formatCompactDollars(o.totalWageredCents)}
        sub="fake dollars, real shame"
      />
      <Cell
        label="In the Arena"
        value={formatCount(o.players)}
        sub={o.players === 1 ? "lonely degenerate" : "registered degenerates"}
      />
      <Cell
        label="Live Now"
        value={formatCount(o.openBets)}
        sub={
          o.openBets > 0
            ? `${formatDollars(o.atRiskCents)} on the line`
            : o.lastBetLabel
              ? `last action ${o.lastBetLabel}`
              : "the board is quiet"
        }
        accent={o.openBets > 0 ? "text-win" : "text-muted"}
      />
    </div>
  );
}

export function HeroStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-[var(--radius)] border border-border bg-panel/70 sm:grid-cols-4 sm:divide-y-0">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 px-5 py-5 sm:px-6">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
      ))}
    </div>
  );
}
