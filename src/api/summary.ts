import { announceWeeklyRecap } from "../utils/announce";
import { linkMentions } from "../utils/format";
import {
  collectWeeklyStats,
  generateWeeklyRecap,
  hadActivity,
  saveRecap,
} from "../utils/summary";

/**
 * Vercel cron target (see vercel.json — runs Sunday noon Eastern). Tallies
 * the past seven days of betting straight from the books, has a cheap model
 * narrate it in the group's voice, then posts the recap to every subscribed
 * group chat. Vercel sends `Authorization: Bearer ${CRON_SECRET}` with cron
 * invocations when the CRON_SECRET env var is set on the project.
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const stats = await collectWeeklyStats();

  // A dead week — don't ping the group with an empty report.
  if (!hadActivity(stats)) {
    return Response.json({ skipped: "no activity", since: stats.since, until: stats.until });
  }

  const recap = await generateWeeklyRecap(stats);

  // Save the generation before posting, so a recap is never lost (and the web
  // surface can render it later). Stored with bare names + the full stats
  // snapshot, so each surface re-links mentions its own way.
  const recapId = await saveRecap(stats, recap);

  // The model writes prose with bare display names; linkMentions turns those
  // into tg:// mentions so the people called out actually get pinged.
  const mentioned = linkMentions(
    recap.body,
    stats.players.map((p) => p.user),
  );

  // Posting is best-effort — a Telegram hiccup shouldn't 500 the cron.
  let announcedThreads = 0;
  try {
    announcedThreads = await announceWeeklyRecap(mentioned);
  } catch (error) {
    console.error("weekly recap announcement failed:", error);
  }

  return Response.json({
    recapId,
    since: stats.since,
    until: stats.until,
    betsPlaced: stats.betsPlaced,
    betsSettled: stats.betsSettled,
    uniqueBettors: stats.uniqueBettors,
    announcedThreads,
  });
}
