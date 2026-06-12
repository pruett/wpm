import { syncAll } from "../utils/sync";
import { announceSettlements } from "../utils/announce";

/**
 * Vercel cron target (see vercel.json — runs every 5 minutes). Mirrors every
 * tracked Kalshi series (src/kalshi/series.ts) into Postgres, settles any
 * decided bets, then recaps the settlements in subscribed group chats.
 * Vercel sends `Authorization: Bearer ${CRON_SECRET}` with cron invocations
 * when the CRON_SECRET env var is set on the project.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { settlements, ...stats } = await syncAll();

  // Announcing is a side show — a Telegram hiccup must not fail the sweep
  // (the books are already updated and the next sweep wouldn't re-announce).
  let announcedThreads = 0;
  try {
    announcedThreads = await announceSettlements(settlements, stats.voidedBets);
  } catch (error) {
    console.error("settlement announcement failed:", error);
  }

  return Response.json({ ...stats, announcedThreads });
}
