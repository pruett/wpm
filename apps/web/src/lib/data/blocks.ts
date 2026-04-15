import { cacheLife, cacheTag } from "next/cache";
import type { Block } from "@wpm/shared";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export async function getBlocks(): Promise<Block[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("blocks");

  const res = await fetch(`${API_BASE}/api/blocks`);
  if (!res.ok) {
    throw new Error(`Failed to fetch blocks: ${res.status}`);
  }
  return res.json();
}
