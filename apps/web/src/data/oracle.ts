import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/lib/db";
import { oracleHeartbeats } from "@/lib/db/schema";
import { tags } from "./tags";

export type HeartbeatRow = {
  job: string;
  status: "ok" | "error";
  message: string | null;
  lastSeenAt: number;
  ageMs: number;
  stale: boolean;
};

const STALE_THRESHOLDS_MS: Record<string, number> = {
  liveness: 3 * 60 * 1000,
  ingest: 3 * 60 * 60 * 1000,
  resolve: 60 * 60 * 1000,
};
const DEFAULT_STALE_MS = 60 * 60 * 1000;

export async function getOracleHeartbeats(): Promise<HeartbeatRow[]> {
  "use cache";
  cacheLife("seconds");
  cacheTag(tags.oracleHeartbeats());

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

export async function recordHeartbeat(
  job: string,
  status: "ok" | "error",
  message: string | null,
): Promise<void> {
  const now = new Date();
  db.insert(oracleHeartbeats)
    .values({ job, status, message, lastSeenAt: now })
    .onConflictDoUpdate({
      target: oracleHeartbeats.job,
      set: { status, message, lastSeenAt: now },
    })
    .run();
}
