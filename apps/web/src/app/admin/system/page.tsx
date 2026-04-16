import { Suspense } from "react";
import { connection } from "next/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHealth } from "@/lib/data/health";
import { SystemEventFeed } from "@/components/system-event-feed";

async function HealthPanel() {
  await connection();
  const health = await getHealth();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Ledger Health
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <div
            className={`h-4 w-4 rounded-full ${health.node ? "bg-green-500" : "bg-destructive"}`}
          />
          <div>
            <p className="font-mono text-2xl font-black">
              {health.status === "ok" ? "Healthy" : "Degraded"}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {health.node ? "Connected" : "Disconnected"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="h-12 w-full animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  );
}

export default function AdminSystemPage() {
  return (
    <div>
      <h1 className="mb-6 font-mono text-2xl font-black uppercase tracking-wider">System</h1>

      <Suspense fallback={<CardSkeleton />}>
        <HealthPanel />
      </Suspense>

      <div className="mt-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Live Event Feed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SystemEventFeed />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
