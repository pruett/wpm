import { Suspense } from "react";

import { SystemEventFeed } from "@/components/system-event-feed";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHealth } from "@/data/health";
import { getOracleHeartbeats, type HeartbeatRow } from "@/data/oracle";

async function HealthPanel() {
  const health = await getHealth();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
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

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function jobBadge(row: HeartbeatRow): { label: string; dotClass: string } {
  if (row.stale) return { label: "Stale", dotClass: "bg-destructive" };
  if (row.status === "error") return { label: "Error", dotClass: "bg-yellow-500" };
  return { label: "Healthy", dotClass: "bg-green-500" };
}

async function OraclePanel() {
  const rows = await getOracleHeartbeats();
  const expectedJobs = ["liveness", "ingest", "resolve"];
  const byJob = new Map(rows.map((r) => [r.job, r]));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Oracle
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {expectedJobs.map((job) => {
            const row = byJob.get(job);
            if (!row) {
              return (
                <div key={job} className="flex items-center gap-3">
                  <div className="h-4 w-4 rounded-full bg-muted" />
                  <div>
                    <p className="font-mono text-sm font-bold uppercase">{job}</p>
                    <p className="font-mono text-xs text-muted-foreground">No heartbeat yet</p>
                  </div>
                </div>
              );
            }
            const badge = jobBadge(row);
            return (
              <div key={job} className="flex items-center gap-3">
                <div className={`h-4 w-4 rounded-full ${badge.dotClass}`} />
                <div>
                  <p className="font-mono text-sm font-bold uppercase">
                    {job} · {badge.label}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    last seen {formatAge(row.ageMs)}
                    {row.message ? ` — ${row.message}` : ""}
                  </p>
                </div>
              </div>
            );
          })}
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
      <h1 className="mb-6 font-mono text-2xl font-black tracking-wider uppercase">System</h1>

      <Suspense fallback={<CardSkeleton />}>
        <HealthPanel />
      </Suspense>

      <div className="mt-6">
        <Suspense fallback={<CardSkeleton />}>
          <OraclePanel />
        </Suspense>
      </div>

      <div className="mt-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
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
