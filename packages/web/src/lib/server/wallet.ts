const EFFECT_API_URL = process.env.EFFECT_API_URL || "http://localhost:4101";

// In-memory cache: email → { token, address }
const walletCache = new Map<string, { token: string; address: string }>();

export async function getWalletToken(
  email: string,
  name: string,
): Promise<{ token: string; address: string }> {
  const cached = walletCache.get(email);
  if (cached) return cached;

  const res = await fetch(`${EFFECT_API_URL}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email }),
  });

  if (!res.ok) {
    throw new Error(`Wallet bridge failed: ${res.status}`);
  }

  const data = (await res.json()) as { token: string; address: string };
  walletCache.set(email, { token: data.token, address: data.address });
  return { token: data.token, address: data.address };
}
