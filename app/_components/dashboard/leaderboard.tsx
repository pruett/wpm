import { getLeaderboard, type Standing } from "@/app/_data/leaderboard";
import { Card, CardBody, CardHeader, CardEyebrow, CardTitle } from "@/app/_components/ui/card";
import { Badge, LiveBadge } from "@/app/_components/ui/badge";
import { Avatar } from "@/app/_components/ui/avatar";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { cn } from "@/app/_lib/utils";
import { formatDollars, formatSignedDollars } from "@/app/_lib/format";

const SEED_CENTS = 10_000_000; // $100,000 starting bankroll
const MEDALS = ["🥇", "🥈", "🥉"];

function Header() {
  return (
    <CardHeader>
      <div>
        <CardEyebrow>Standings</CardEyebrow>
        <CardTitle>The Pecking Order</CardTitle>
      </div>
      <Badge tone="gold">Bankroll</Badge>
    </CardHeader>
  );
}

function Row({ s, rank }: { s: Standing; rank: number }) {
  const pnl = s.totalCents - SEED_CENTS;
  const isLeader = rank === 0;
  const medal = MEDALS[rank];

  return (
    <li
      className={cn(
        "flex items-center gap-3 px-5 py-3 transition-colors hover:bg-white/[0.02]",
        isLeader && "bg-gold/[0.04]",
      )}
    >
      <div className="flex w-7 shrink-0 justify-center">
        {medal ? (
          <span className="text-xl">{medal}</span>
        ) : (
          <span className="nums text-sm font-semibold text-faint">{rank + 1}</span>
        )}
      </div>

      <Avatar initials={s.initials} seed={s.id} />

      <div className="min-w-0 flex-1">
        <div className={cn("truncate font-semibold", isLeader ? "text-gold" : "text-foreground")}>
          {s.name}
        </div>
        <div className="nums text-xs text-muted">
          {s.wins}W-{s.losses}L
          {s.openBets > 0 && (
            <span className="text-win"> · {s.openBets} live</span>
          )}
        </div>
      </div>

      <div className="flex flex-col items-end">
        <span className="nums text-base font-bold text-foreground sm:text-lg">
          {formatDollars(s.totalCents)}
        </span>
        <span
          className={cn(
            "nums text-xs font-semibold",
            pnl > 0 ? "text-win" : pnl < 0 ? "text-loss" : "text-muted",
          )}
        >
          {formatSignedDollars(pnl)}
        </span>
      </div>
    </li>
  );
}

/** Full bankroll standings — everyone, ranked, seed line at $100k. */
export async function Leaderboard() {
  const standings = await getLeaderboard();

  return (
    <Card>
      <CardHeader>
        <div>
          <CardEyebrow>Standings</CardEyebrow>
          <CardTitle>The Pecking Order</CardTitle>
        </div>
        <LiveBadge label="Bankroll" />
      </CardHeader>
      {standings.length === 0 ? (
        <CardBody className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <span className="text-4xl">📋</span>
          <p className="display text-2xl text-muted">No players yet.</p>
          <p className="max-w-[30ch] text-sm text-muted">
            Hit <span className="nums text-foreground">/start</span> in the group chat to open an
            account and claim your $100,000.
          </p>
        </CardBody>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {standings.map((s, i) => (
              <Row key={s.id} s={s} rank={i} />
            ))}
          </ul>
          <div className="border-t border-border px-5 py-3 text-center text-xs text-faint">
            Everyone starts at <span className="nums text-muted">$100,000</span>. Distance from
            that line is profit — or a cry for help.
          </div>
        </>
      )}
    </Card>
  );
}

export function LeaderboardSkeleton() {
  return (
    <Card>
      <Header />
      <ul className="divide-y divide-border">
        {Array.from({ length: 5 }).map((_, i) => (
          <li key={i} className="flex items-center gap-3 px-5 py-3">
            <Skeleton className="size-5 rounded-md" />
            <Skeleton className="size-9 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-12" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
