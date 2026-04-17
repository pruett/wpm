import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/lib/db";
import { oracleHeartbeats } from "@/lib/db/schema";

export type HeartbeatRow = {
  job: string;
  status: "ok" | "error";
  message: string | null;
  lastSeenAt: number;
  ageMs: number;
  stale: boolean;
};

// Stale thresholds: allow ~1.5× the scheduled interval before we consider a job dead.
const STALE_THRESHOLDS_MS: Record<string, number> = {
  liveness: 3 * 60 * 1000, // 1m schedule → stale after 3m
  ingest: 3 * 60 * 60 * 1000, // 2h schedule → stale after 3h
  resolve: 60 * 60 * 1000, // 30m schedule → stale after 60m
};
const DEFAULT_STALE_MS = 60 * 60 * 1000;

export async function getOracleHeartbeats(): Promise<HeartbeatRow[]> {
  "use cache";
  cacheLife("seconds");
  cacheTag("oracle-heartbeats");

  const now = Date.now();
  const rows = db.select().from(oracleHeartbeats).all();
  return rows.map((r) => {
    const lastSeen = r.lastSeenAt.getTime();
    const ageMs = now - lastSeen;
    const threshold = STALE_THRESHOLDS_MS[r.job] ?? DEFAULT_STALE_MS;
    return {
      job: r.job,
      status: r.status,
      message: r.message,
      lastSeenAt: lastSeen,
      ageMs,
      stale: ageMs > threshold,
    };
  });
}
