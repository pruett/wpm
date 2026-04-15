import { cacheLife, cacheTag } from "next/cache";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

export type BalanceData = {
  balance: number;
  address: string;
};

export async function getBalance(userId: string): Promise<BalanceData> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`viewer:${userId}`);

  const res = await fetch(`${API_BASE}/api/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch balance: ${res.status}`);
  }
  const data = (await res.json()) as { token: string; address: string; balance: number };
  return { balance: data.balance, address: data.address };
}
