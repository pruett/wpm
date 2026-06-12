import { syncAll } from "../utils/sync";

/**
 * Vercel cron target (see vercel.json — runs every 5 minutes). Mirrors every
 * tracked Kalshi series (src/kalshi/series.ts) into Postgres and settles any
 * decided bets. Vercel sends `Authorization: Bearer ${CRON_SECRET}` with cron
 * invocations when the CRON_SECRET env var is set on the project.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  return Response.json(await syncAll());
}
