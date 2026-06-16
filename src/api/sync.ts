import {
  claimUnannouncedSettlements,
  releaseAnnouncements,
  releaseBettableAlerts,
  syncAll,
} from "../utils/sync";
import { announceBettableAlerts, announceSettlements } from "../utils/announce";

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

  // syncAll settles bets in Postgres but no longer hands us the recap to post —
  // announcements read PERSISTED state below so a failed post is retried next
  // sweep instead of lost. (syncAll still returns its in-memory settlements for
  // logging parity; we deliberately ignore them here.)
  const { bettableAlerts, ...stats } = await syncAll();

  // Claim every settled-but-unannounced bet (stamps announcedAt atomically so
  // overlapping sweeps don't double-post), then announce. If ZERO group threads
  // got it — all groups dead, none subscribed, or Telegram down — release the
  // claim so the next sweep retries. A partial success (>=1 thread) stays
  // claimed, to avoid re-posting to the groups that already received it.
  let announcedThreads = 0;
  const claimed = await claimUnannouncedSettlements();
  if (claimed.claimedBetIds.length > 0) {
    try {
      announcedThreads = await announceSettlements(claimed.settlements, claimed.voidedBets);
    } catch (error) {
      console.error("settlement announcement failed:", error);
    }
    if (announcedThreads === 0) await releaseAnnouncements(claimed.claimedBetIds);
  }

  // Last-call alerts are claimed the same way (claimBettableAlerts already
  // flipped bettableAnnounced); release on total failure so they retry while
  // the event is still pre-kickoff.
  let alertedThreads = 0;
  if (bettableAlerts.length > 0) {
    try {
      alertedThreads = await announceBettableAlerts(bettableAlerts);
    } catch (error) {
      console.error("bettable alert announcement failed:", error);
    }
    if (alertedThreads === 0) {
      await releaseBettableAlerts(bettableAlerts.map((a) => a.eventTicker));
    }
  }

  return Response.json({ ...stats, announcedThreads, alertedThreads });
}
