import { sync } from "../utils/sync";

const SERIES_TICKER = process.env.KALSHI_SERIES ?? "KXWCGAME";

/**
 * Vercel cron target (see vercel.json — runs every 5 minutes). Mirrors the
 * Kalshi series into Postgres and settles any decided bets. Vercel sends
 * `Authorization: Bearer ${CRON_SECRET}` with cron invocations when the
 * CRON_SECRET env var is set on the project.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const stats = await sync(SERIES_TICKER);
  return Response.json({ series: SERIES_TICKER, ...stats });
}
