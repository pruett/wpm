// v2 (Next.js Route Handler) mirror of the production heartbeat at /api/health.
// Thin shim over the same handler as `api/health.mjs` (src/api/health.ts).
// Unauthenticated; safe to hit directly to confirm the Next-native path reaches
// Postgres and the Telegram API the same way the .mjs build does. We call
// heartbeat("v2") rather than re-exporting the bare GET so this path self-reports
// as v2 in the response's `apiVersion.servedBy`.
import { heartbeat } from "@/src/api/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = () => heartbeat("v2");
