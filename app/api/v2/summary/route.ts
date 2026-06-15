// v2 (Next.js Route Handler) mirror of the production cron at /api/summary.
// Thin shim re-exporting the same handler as `api/summary.mjs`
// (src/api/summary.ts). Production cron still targets /api/summary; this lets
// us validate the Next-native path before switching over. The weekly recap
// makes an LLM call, so allow the long execution window.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export { GET } from "@/src/api/summary";
