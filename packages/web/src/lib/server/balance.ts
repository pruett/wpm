import { API_URL } from "@wpm/shared";
import { getWalletToken } from "./wallet.js";

/**
 * Resolves the wallet for a user and fetches their current balance.
 * Returns nulls on failure so callers can render a loading/empty state
 * instead of failing the whole layout load.
 */
export async function fetchUserBalance(user: {
  email: string;
  name: string;
}): Promise<{ balance: number | null; address: string | null }> {
  try {
    const { token, address } = await getWalletToken(user.email, user.name);
    const res = await fetch(`${API_URL}/api/balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { balance: null, address };
    const body = (await res.json()) as { balance: number };
    return { balance: body.balance, address };
  } catch {
    return { balance: null, address: null };
  }
}
