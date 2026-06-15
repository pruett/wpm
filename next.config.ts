import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root also hosts the bot's Vercel Functions in `/api` and the
  // Bun bot code in `/src`; Next only owns the `app/` directory.

  // Cache Components (PPR): the dashboard is a static shell with per-panel
  // `use cache` data islands that each stream behind their own skeleton.
  cacheComponents: true,
};

export default nextConfig;
