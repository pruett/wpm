// v2 (Next.js Route Handler) mirror of the production heartbeat at /api/health.
// Thin shim re-exporting the same handler as `api/health.mjs`
// (src/api/health.ts). Unauthenticated; safe to hit directly to confirm the
// Next-native path reaches Postgres and the Telegram API the same way the
// .mjs build does.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export { GET } from "@/src/api/health";
