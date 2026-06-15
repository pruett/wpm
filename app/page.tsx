import { Suspense } from "react";
import { LiveBadge } from "@/app/_components/ui/badge";
import { HeroStats, HeroStatsSkeleton } from "@/app/_components/dashboard/hero-stats";
import { PoolStats, PoolStatsSkeleton } from "@/app/_components/dashboard/pool-stats";
import { MvpCard, MvpCardSkeleton } from "@/app/_components/dashboard/mvp-card";
import { Rundown, RundownSkeleton } from "@/app/_components/dashboard/rundown";
import { Trophies, TrophiesSkeleton } from "@/app/_components/dashboard/trophies";
import { Leaderboard, LeaderboardSkeleton } from "@/app/_components/dashboard/leaderboard";

// A short repeating strip of house philosophy under the masthead.
const TICKER = [
  "Fake money",
  "Real consequences",
  "The house always remembers",
  "Touch grass? Never heard of it",
  "Bet responsibly (do not)",
  "Someone is always wrong",
];

/** Reveal wrapper — staggers each panel in on load (CSS-only, motion-safe). */
function Reveal({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rise ${className ?? ""}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12">
      {/* ---- Masthead (static shell, instant from the edge) ---- */}
      <header className="mb-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow mb-1 text-gold/80">A Tight-Knit Circle of Degenerates</p>
            <h1 className="display text-6xl text-foreground sm:text-7xl">
              Wampum<span className="text-gold">.</span>
            </h1>
          </div>
          <div className="hidden flex-col items-end gap-2 sm:flex">
            <LiveBadge label="Live" />
            <span className="text-xs text-muted">Refreshes every hour</span>
          </div>
        </div>
        <p className="mt-2 max-w-[48ch] text-sm text-muted">
          The official sportsbook of people who should know better. Standings, superlatives, and
          the weekly word from the commissioner — all betting fake money against a real market.
        </p>
        <div className="mt-3 flex sm:hidden">
          <LiveBadge label="Live · hourly" />
        </div>
      </header>

      {/* ---- Decorative ticker ---- */}
      <div className="mb-8 overflow-hidden rounded-full border border-border bg-panel/60 py-2">
        <div className="flex w-max gap-6 whitespace-nowrap pr-6" style={{ animation: "ticker 28s linear infinite" }}>
          {[...TICKER, ...TICKER].map((t, i) => (
            <span key={i} className="flex items-center gap-6 text-xs font-semibold uppercase tracking-widest text-faint">
              {t}
              <span className="text-gold/60">✦</span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:gap-5">
        {/* ---- Hero marquee ---- */}
        <Reveal>
          <Suspense fallback={<HeroStatsSkeleton />}>
            <HeroStats />
          </Suspense>
        </Reveal>

        {/* ---- The Book (pool vitals) ---- */}
        <Reveal delay={60}>
          <Suspense fallback={<PoolStatsSkeleton />}>
            <PoolStats />
          </Suspense>
        </Reveal>

        {/* ---- MVP + Rundown ---- */}
        <div className="grid gap-4 sm:gap-5 lg:grid-cols-3">
          <Reveal delay={120} className="lg:col-span-1 lg:h-full">
            <Suspense fallback={<MvpCardSkeleton />}>
              <MvpCard />
            </Suspense>
          </Reveal>
          <Reveal delay={160} className="lg:col-span-2 lg:h-full">
            <Suspense fallback={<RundownSkeleton />}>
              <Rundown />
            </Suspense>
          </Reveal>
        </div>

        {/* ---- Trophy case ---- */}
        <Reveal delay={220}>
          <Suspense fallback={<TrophiesSkeleton />}>
            <Trophies />
          </Suspense>
        </Reveal>

        {/* ---- Standings ---- */}
        <Reveal delay={280}>
          <Suspense fallback={<LeaderboardSkeleton />}>
            <Leaderboard />
          </Suspense>
        </Reveal>
      </div>

      <footer className="mt-12 flex flex-col items-center gap-1 text-center text-xs text-faint">
        <p>
          Wampum runs on Kalshi prices and questionable decisions. No real money, no real
          financial advice, no real hope.
        </p>
        <p>Numbers refresh hourly · the house keeps the receipts.</p>
      </footer>
    </main>
  );
}
