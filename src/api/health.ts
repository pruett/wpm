import { sql } from "../db";

// The Vercel cron (vercel.json) syncs every 5 minutes; within 3 intervals
// the mirror is healthy.
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
    // postgres.js may hand the aggregate back as a string, not a Date.
    const [row] = await sql<
      { lastSync: string | Date | null }[]
    >`SELECT max(synced_at) AS "lastSync" FROM markets`;
    const lastSync = row?.lastSync ? new Date(row.lastSync) : null;
    const ageMs = lastSync ? Date.now() - lastSync.getTime() : null;
    const syncFresh = ageMs != null && ageMs <= MAX_SYNC_AGE_MS;
    checks.db = { ok: true };
    checks.sync = {
      ok: syncFresh,
      lastSyncedAt: lastSync?.toISOString() ?? null,
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
      result?: {
        url: string;
        pending_update_count: number;
        last_error_message?: string;
        last_error_date?: number;
      };
    };
    const info = json.result;
    // A non-empty last_error_message lingers until the next successful delivery,
    // so it can stay set long after a one-off transient blip (e.g. a serverless
    // instance teardown resetting Telegram's POST). Only treat the webhook as
    // unhealthy when there's a recent error or a real backlog of updates.
    const lastErrorAgeMs = info?.last_error_date
      ? Date.now() - info.last_error_date * 1000
      : Infinity;
    const webhookOk =
      json.ok &&
      !!info?.url &&
      (info.pending_update_count ?? 0) < 10 &&
      lastErrorAgeMs > 5 * 60 * 1000;
    checks.telegramWebhook = {
      ok: webhookOk,
      registered: !!info?.url,
      pendingUpdates: info?.pending_update_count ?? null,
      lastError: info?.last_error_message ?? null,
      lastErrorAgeSeconds: Number.isFinite(lastErrorAgeMs)
        ? Math.round(lastErrorAgeMs / 1000)
        : null,
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
