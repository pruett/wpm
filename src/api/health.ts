import { sql } from "../db";

// The Vercel cron (vercel.json) syncs every 5 minutes; within 3 intervals
// the mirror is healthy — the same tolerance utils/house.ts uses to gate bets.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SYNC_AGE_MS = 3 * SYNC_INTERVAL_MS;

/**
 * Unauthenticated heartbeat for the production deploy: checks the pieces
 * that have actually failed before — postgres connectivity, cron sync
 * freshness, and the Telegram webhook registration. 200 when everything
 * is healthy, 503 with the same JSON body when any check fails.
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let healthy = true;

  try {
    const [row] = await sql<
      { lastSync: Date | null }[]
    >`SELECT max(synced_at) AS "lastSync" FROM markets`;
    const ageMs = row?.lastSync ? Date.now() - new Date(row.lastSync).getTime() : null;
    const syncFresh = ageMs != null && ageMs <= MAX_SYNC_AGE_MS;
    checks.db = { ok: true };
    checks.sync = {
      ok: syncFresh,
      lastSyncedAt: row?.lastSync?.toISOString() ?? null,
      ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    };
    if (!syncFresh) healthy = false;
  } catch (err) {
    checks.db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    checks.sync = { ok: false };
    healthy = false;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`,
    );
    const json = (await res.json()) as {
      ok: boolean;
      result?: { url: string; pending_update_count: number; last_error_message?: string };
    };
    const info = json.result;
    const webhookOk = json.ok && !!info?.url && !info.last_error_message;
    checks.telegramWebhook = {
      ok: webhookOk,
      registered: !!info?.url,
      pendingUpdates: info?.pending_update_count ?? null,
      lastError: info?.last_error_message ?? null,
    };
    if (!webhookOk) healthy = false;
  } catch (err) {
    checks.telegramWebhook = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    healthy = false;
  }

  return Response.json(
    { status: healthy ? "ok" : "degraded", timestamp: new Date().toISOString(), checks },
    { status: healthy ? 200 : 503 },
  );
}
