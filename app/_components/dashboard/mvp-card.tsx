import { getMvp } from "@/app/_data/mvp";
import { Card, CardBody, CardHeader, CardEyebrow, CardTitle } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Avatar } from "@/app/_components/ui/avatar";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { formatDollars, formatSignedDollars } from "@/app/_lib/format";

function Header({ positive }: { positive?: boolean }) {
  return (
    <CardHeader>
      <div>
        <CardEyebrow>Player of the Week</CardEyebrow>
        <CardTitle>{positive === false ? "Least Bad" : "MVP"}</CardTitle>
      </div>
      <Badge tone="gold">7-Day</Badge>
    </CardHeader>
  );
}

/** This week's standout — or, on a brutal week, the one who bled the slowest. */
export async function MvpCard() {
  const mvp = await getMvp();

  if (!mvp || !mvp.hasActivity) {
    return (
      <Card className="flex h-full flex-col">
        <Header />
        <CardBody className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <span className="text-4xl">🦗</span>
          <p className="display text-2xl text-muted">Crickets.</p>
          <p className="max-w-[24ch] text-sm text-muted">
            Not a single bet this week. The whole group went outside and touched grass.
            Disgraceful.
          </p>
        </CardBody>
      </Card>
    );
  }

  const record = `${mvp.wins}W-${mvp.losses}L${mvp.voids ? `-${mvp.voids}V` : ""}`;

  return (
    <Card className="flex h-full flex-col">
      <Header positive={mvp.positive} />
      <CardBody className="flex flex-1 flex-col gap-5">
        <div className="flex items-center gap-4">
          <Avatar
            initials={mvp.initials}
            seed={mvp.seed}
            className="size-14 text-base"
          />
          <div className="min-w-0">
            <div className="truncate text-lg font-bold text-foreground">{mvp.name}</div>
            <div className="text-sm text-muted">
              {record} · {mvp.betsPlaced} placed
            </div>
          </div>
        </div>

        <div className="flex items-baseline gap-2">
          <span
            className={`nums text-5xl font-bold leading-none ${mvp.positive ? "text-win" : "text-loss"}`}
          >
            {formatSignedDollars(mvp.realizedCents)}
          </span>
          <span className="eyebrow">net this week</span>
        </div>

        {mvp.biggestWin ? (
          <div className="rounded-xl border border-win/20 bg-win/[0.06] px-4 py-3">
            <div className="eyebrow text-win/80">Signature Win</div>
            <p className="mt-1 text-sm text-foreground">
              +{formatDollars(mvp.biggestWin.profitCents)}{" "}
              {mvp.biggestWin.side === "yes" ? "on" : "against"}{" "}
              {mvp.biggestWin.outcome}
              <span className="text-faint"> · {mvp.biggestWin.title}</span>
            </p>
          </div>
        ) : (
          <p className="rounded-xl border border-border bg-panel-2 px-4 py-3 text-sm text-muted">
            {mvp.positive
              ? "Grinding it out — no single haymaker, just clean profit."
              : "Top of a leaderboard nobody wanted to lead. Better luck next week."}
          </p>
        )}

        {mvp.runnersUp.length > 0 && (
          <div className="mt-auto border-t border-border pt-4">
            <div className="eyebrow mb-2">The Chasers</div>
            <ul className="flex flex-col gap-1.5">
              {mvp.runnersUp.map((r, i) => (
                <li key={i} className="flex items-center justify-between text-sm">
                  <span className="truncate text-muted">
                    <span className="nums mr-2 text-faint">{i + 2}.</span>
                    {r.name}
                  </span>
                  <span
                    className={`nums font-semibold ${r.realizedCents >= 0 ? "text-win" : "text-loss"}`}
                  >
                    {formatSignedDollars(r.realizedCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function MvpCardSkeleton() {
  return (
    <Card className="flex h-full flex-col">
      <Header />
      <CardBody className="flex flex-1 flex-col gap-5">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3.5 w-24" />
          </div>
        </div>
        <Skeleton className="h-12 w-44" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </CardBody>
    </Card>
  );
}
