import { getTrophies, type Trophy } from "@/app/_data/trophies";
import { Card, CardBody, CardHeader, CardEyebrow, CardTitle } from "@/app/_components/ui/card";
import { Badge } from "@/app/_components/ui/badge";
import { Skeleton } from "@/app/_components/ui/skeleton";

const TONE_RING: Record<Trophy["tone"], string> = {
  gold: "border-gold/25 hover:border-gold/50",
  win: "border-win/20 hover:border-win/45",
  loss: "border-loss/20 hover:border-loss/45",
  ice: "border-ice/20 hover:border-ice/45",
  violet: "border-violet/20 hover:border-violet/45",
};

const TONE_TEXT: Record<Trophy["tone"], string> = {
  gold: "text-gold",
  win: "text-win",
  loss: "text-loss",
  ice: "text-ice",
  violet: "text-violet",
};

function Header() {
  return (
    <CardHeader>
      <div>
        <CardEyebrow>The Trophy Case</CardEyebrow>
        <CardTitle>Superlatives & Shame</CardTitle>
      </div>
      <Badge tone="neutral">Hall of Fame</Badge>
    </CardHeader>
  );
}

/** Sarcastic, data-driven hardware handed out across all-time betting history. */
export async function Trophies() {
  const trophies = await getTrophies();

  if (trophies.length === 0) {
    return (
      <Card>
        <Header />
        <CardBody className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <span className="text-4xl">🏆</span>
          <p className="display text-2xl text-muted">The case is empty.</p>
          <p className="max-w-[36ch] text-sm text-muted">
            No bets, no bragging rights. Hardware gets handed out the moment someone
            actually puts money down.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <Header />
      <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {trophies.map((t, i) => (
          <article
            key={t.title}
            className={`group flex flex-col gap-2 rounded-xl border bg-panel-2/60 p-4 transition-colors ${TONE_RING[t.tone]}`}
            style={{ animationDelay: `${i * 45}ms` }}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="text-2xl leading-none transition-transform group-hover:scale-110">
                {t.emoji}
              </span>
              <span className={`eyebrow text-right ${TONE_TEXT[t.tone]}`}>{t.title}</span>
            </div>
            <div className="mt-1 truncate text-base font-bold text-foreground">{t.winner}</div>
            <div className={`nums text-sm font-semibold ${TONE_TEXT[t.tone]}`}>{t.stat}</div>
            <p className="text-xs leading-snug text-muted">{t.blurb}</p>
          </article>
        ))}
      </CardBody>
    </Card>
  );
}

export function TrophiesSkeleton() {
  return (
    <Card>
      <Header />
      <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-panel-2/60 p-4">
            <div className="flex items-start justify-between">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-2.5 w-20" />
            </div>
            <Skeleton className="mt-1 h-5 w-28" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
