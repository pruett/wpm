import { desc } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/src/db";
import { recaps } from "@/src/db/schema";
import { timeAgo } from "@/app/_lib/format";

export interface Rundown {
  /** Telegram-flavored markdown with bare names — rendered as light markdown. */
  body: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  /** "2h ago" relative to cache-generation time; refreshed each revalidation. */
  ageLabel: string;
  /** Gateway model id that wrote it, or "fallback". */
  model: string;
  /** A few headline numbers lifted from the saved stats snapshot. */
  betsPlaced: number | null;
  totalStakedCents: number | null;
  wins: number | null;
  losses: number | null;
}

/** Loose view of the WeeklyStats snapshot saved alongside each recap. */
interface SavedStats {
  betsPlaced?: number;
  totalStakedCents?: number;
  wins?: number;
  losses?: number;
}

/**
 * The most recent "Sunday Rundown" — the LLM-written weekly recap, pulled
 * straight from the `recaps` table the cron writes before it posts to Telegram.
 */
export async function getRundown(): Promise<Rundown | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("dashboard", "recaps");

  try {
    const [row] = await db
      .select()
      .from(recaps)
      .orderBy(desc(recaps.createdAt))
      .limit(1);

    if (!row) return null;

    const stats = (row.stats ?? {}) as SavedStats;

    return {
      body: row.body,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      createdAt: row.createdAt,
      ageLabel: timeAgo(row.createdAt),
      model: row.model,
      betsPlaced: stats.betsPlaced ?? null,
      totalStakedCents: stats.totalStakedCents ?? null,
      wins: stats.wins ?? null,
      losses: stats.losses ?? null,
    };
  } catch (err) {
    console.error("getRundown failed:", err);
    return null;
  }
}
