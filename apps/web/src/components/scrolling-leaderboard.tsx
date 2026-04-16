import { connection } from "next/server";
import { getLeaderboard } from "@/lib/data/leaderboard";

export async function ScrollingLeaderboard() {
  await connection();
  const entries = await getLeaderboard();

  if (entries.length === 0) return null;

  const sorted = [...entries].sort((a, b) => b.balance - a.balance);

  const items = sorted.map((entry, i) => (
    <span key={entry.userId} className="inline-flex shrink-0 items-center gap-1.5 px-4">
      <span className="text-muted-foreground">{i + 1}.</span>
      <span className="font-medium">{entry.name || entry.userId.slice(0, 8)}</span>
      <span className="text-muted-foreground">{entry.balance.toLocaleString()}</span>
    </span>
  ));

  return (
    <div className="overflow-hidden border-b border-border bg-card/50">
      <div className="relative flex h-8 items-center font-mono text-xs">
        <span className="z-10 shrink-0 border-r border-border bg-background px-3 font-bold uppercase tracking-wider">
          Top
        </span>
        <div className="marquee-track flex min-w-full">
          <div className="marquee-content flex shrink-0">{items}</div>
          <div className="marquee-content flex shrink-0" aria-hidden>
            {items}
          </div>
        </div>
      </div>
    </div>
  );
}
