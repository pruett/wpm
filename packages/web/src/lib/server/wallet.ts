import { API_URL } from "@wpm/shared";

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const walletCache = new Map<string, { token: string; address: string; expiresAt: number }>();

export async function getWalletToken(
  email: string,
  name: string,
): Promise<{ token: string; address: string }> {
  const cached = walletCache.get(email);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const res = await fetch(`${API_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });

  if (!res.ok) {
    throw new Error(`Wallet bridge failed: ${res.status}`);
  }

  const data = (await res.json()) as { token: string; address: string };
  walletCache.set(email, {
    token: data.token,
    address: data.address,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return { token: data.token, address: data.address };
}
