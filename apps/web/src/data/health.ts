import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { tags } from "./tags";

export type HealthData = {
  status: "ok" | "degraded";
  node: boolean;
};

export async function getHealth(): Promise<HealthData> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.health());

  try {
    await db.get(sql`select 1`);
    return { status: "ok", node: true };
  } catch {
    return { status: "degraded", node: false };
  }
}
