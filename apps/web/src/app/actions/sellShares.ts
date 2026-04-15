"use server";

import { headers } from "next/headers";
import { updateTag } from "next/cache";
import { z } from "zod/v4";
import { auth } from "@/lib/auth";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

const SellSharesInput = z.object({
  marketId: z.string().min(1),
  outcome: z.enum(["A", "B"]),
  shares: z.number().positive(),
});

export async function sellShares(input: z.input<typeof SellSharesInput>) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { error: "Not authenticated" };
  }

  const parsed = SellSharesInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const { marketId, outcome, shares } = parsed.data;

  const walletRes = await fetch(`${API_BASE}/api/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: session.user.id }),
  });
  if (!walletRes.ok) {
    return { error: "Failed to load wallet" };
  }
  const { token } = (await walletRes.json()) as { token: string };

  const res = await fetch(`${API_BASE}/api/sell`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ marketId, outcome, shares }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: (body as { error?: string })?.error ?? `Sell failed (${res.status})` };
  }

  updateTag(`market:${marketId}`);
  updateTag(`viewer:${session.user.id}`);

  return { success: true };
}
