// v2 (Next.js Route Handler) for the production heartbeat at /api/v2/health.
// Full handler lives here (migrated from src/api/health.ts); it hits Postgres
// and the Telegram API the same way the legacy bundled `api/health.mjs` (v1)
// does. Unauthenticated; safe to hit directly. This path self-reports as "v2"
// in the response's `apiVersion.servedBy`.
import { sql } from "@/src/db";

// Route handlers are dynamic by default under cacheComponents, so the former
// `runtime = "nodejs"` (now the default) and `dynamic = "force-dynamic"` exports
// are dropped — they're incompatible with that flag. Only the duration stays.
export const maxDuration = 30;

// The Vercel cron (vercel.json) syncs every 5 minutes; within 3 intervals
// the mirror is healthy.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SYNC_AGE_MS = 3 * SYNC_INTERVAL_MS;

/**
 * The two delivery paths a request can travel: the legacy bundled Vercel
 * Functions (`api/*.mjs`, served at /api/*) and the Next.js route handlers
 * (`app/api/v2/*`, served at /api/v2/*). Both run the same underlying modules,
 * so "which version" is purely about wiring, not behaviour.
 */
type ApiVersion = "v1" | "v2" | "unknown";

/** Classify an API path by its prefix: /api/v2/* is v2, any other /api/* is v1. */
function apiVersionFromPath(pathname: string | null | undefined): ApiVersion {
  if (!pathname) return "unknown";
  if (/\/api\/v2(\/|$)/.test(pathname)) return "v2";
  if (/\/api(\/|$)/.test(pathname)) return "v1";
  return "unknown";
}

/**
 * Unauthenticated heartbeat for the production deploy: checks the pieces
 * that have actually failed before — postgres connectivity, cron sync
 * freshness, and the Telegram webhook registration. 200 when everything
 * is healthy, 503 with the same JSON body when any check fails.
 *
 * `servedBy` records which delivery path answered this request so that hitting
 * /api/health (v1) and /api/v2/health (v2) self-identifies during the gradual
 * switchover. The Telegram webhook's version, by contrast, is *measured* live
 * from the registered URL — that's the source of truth for which path prod
 * traffic actually reaches.
 */
export async function GET() {
  const checks: Record<string, unknown> = {};
  let healthy = true;
  let telegramWebhookVersion: ApiVersion = "unknown";

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
    // Derive the version prod traffic actually hits from the registered URL's
    // path — this is the live switchover signal, independent of who serves
    // this health check.
    let webhookPath: string | null = null;
    if (info?.url) {
      try {
        webhookPath = new URL(info.url).pathname;
      } catch {
        webhookPath = null;
      }
    }
    telegramWebhookVersion = apiVersionFromPath(webhookPath);
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
      version: telegramWebhookVersion,
      url: info?.url ?? null,
      path: webhookPath,
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
    {
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      // At-a-glance switchover state: which path answered this request vs.
      // which path prod's Telegram traffic is actually wired to. A mismatch
      // (e.g. servedBy "v2" but telegramWebhook still "v1") shows the cutover
      // is mid-flight.
      apiVersion: {
        servedBy: "v2" satisfies ApiVersion,
        telegramWebhook: telegramWebhookVersion,
      },
      checks,
    },
    { status: healthy ? 200 : 503 },
  );
}
