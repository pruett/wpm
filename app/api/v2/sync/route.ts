// v2 (Next.js Route Handler) mirror of the production cron at /api/sync.
// This is a thin shim: it re-exports the SAME handler the built `api/sync.mjs`
// uses (src/api/sync.ts), so there is one source of truth and zero logic drift.
// Production crons still target /api/sync (the .mjs); this exists so we can
// validate the Next-native path before switching the cron over.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export { GET } from "@/src/api/sync";
