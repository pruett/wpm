"use server";

import { headers } from "next/headers";
import { updateTag } from "next/cache";
import { z } from "zod/v4";
import { auth, isAdmin } from "@/lib/auth";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

const DistributeInput = z.object({
  userId: z.string().min(1),
  amount: z.number().positive(),
});

export async function distributeTokens(input: z.input<typeof DistributeInput>) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!isAdmin(session)) {
    return { error: "Unauthorized" };
  }

  const parsed = DistributeInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const { userId, amount } = parsed.data;

  const walletRes = await fetch(`${API_BASE}/api/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!walletRes.ok) {
    return { error: "User wallet not found" };
  }
  const { address } = (await walletRes.json()) as { address: string };

  const res = await fetch(`${API_BASE}/api/admin/distribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, amount, reason: "admin_distribute" }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: (body as { error?: string })?.error ?? `Distribution failed (${res.status})` };
  }

  updateTag("users");
  updateTag(`viewer:${userId}`);
  updateTag("leaderboard");

  return { success: true };
}
