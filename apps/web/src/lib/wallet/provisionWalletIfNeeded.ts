const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

interface RegisterResponse {
  token: string;
  address: string;
  balance: number;
}

export async function provisionWalletIfNeeded(user: {
  id: string;
  walletPublicKey: string | null | undefined;
}): Promise<string> {
  if (user.walletPublicKey) {
    return user.walletPublicKey;
  }

  const address = await registerOrRecoverWallet(user.id);
  persistWalletAddress(user.id, address);
  return address;
}

async function registerOrRecoverWallet(userId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });

  if (res.ok) {
    const data = (await res.json()) as RegisterResponse;
    return data.address;
  }

  if (res.status === 409) {
    return lookupExistingWallet(userId);
  }

  throw new Error(`Wallet registration failed: ${res.status}`);
}

async function lookupExistingWallet(userId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });

  if (!res.ok) {
    throw new Error(`Wallet lookup failed: ${res.status}`);
  }

  const data = (await res.json()) as RegisterResponse;
  return data.address;
}

function persistWalletAddress(userId: string, address: string) {
  const Database = require("better-sqlite3");
  const db = new Database(process.env.DATABASE_PATH ?? "data/wpm.db");
  try {
    db.prepare("UPDATE user SET walletPublicKey = ? WHERE id = ?").run(address, userId);
  } finally {
    db.close();
  }
}
