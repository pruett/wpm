import { cacheLife, cacheTag } from "next/cache";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export type HealthData = {
  status: "ok" | "degraded";
  node: boolean;
};

export async function getHealth(): Promise<HealthData> {
  "use cache";
  cacheLife("minutes");
  cacheTag("health");

  const res = await fetch(`${API_BASE}/api/health`);
  if (!res.ok) {
    return { status: "degraded", node: false };
  }
  return res.json();
}
