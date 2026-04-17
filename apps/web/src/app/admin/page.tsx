import { Suspense } from "react";
import { connection } from "next/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateMarketDialog } from "@/components/create-market-dialog";
import { getMarkets } from "@/lib/data/markets";
import { getUsers } from "@/lib/data/users";
import { getHealth } from "@/lib/data/health";

async function OverviewCards() {
  await connection();
  const [marketsData, users, health] = await Promise.all([getMarkets(), getUsers(), getHealth()]);

  const activeMarkets = marketsData.markets.filter((m) => m.status === "open").length;
  const totalMarkets = marketsData.markets.length;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Active Markets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl font-black tabular-nums">{activeMarkets}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{totalMarkets} total</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Users
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-3xl font-black tabular-nums">{users.length}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">registered</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            Node Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <div
              className={`h-3 w-3 rounded-full ${health.node ? "bg-green-500" : "bg-destructive"}`}
            />
            <p className="font-mono text-3xl font-black">
              {health.status === "ok" ? "OK" : "Down"}
            </p>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {health.node ? "Connected" : "Disconnected"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminPage() {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-mono text-2xl font-black uppercase tracking-wider">Overview</h1>
        <CreateMarketDialog />
      </div>
      <Suspense
        fallback={
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                </CardHeader>
                <CardContent>
                  <div className="h-9 w-16 animate-pulse rounded bg-muted" />
                </CardContent>
              </Card>
            ))}
          </div>
        }
      >
        <OverviewCards />
      </Suspense>
    </div>
  );
}
