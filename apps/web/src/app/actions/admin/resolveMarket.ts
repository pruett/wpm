"use server";

import { headers } from "next/headers";
import { updateTag } from "next/cache";
import { z } from "zod/v4";
import { auth, isAdmin } from "@/lib/auth";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

const ResolveMarketInput = z.object({
  marketId: z.string().min(1),
  result: z.enum(["A", "B"]),
});

export async function resolveMarket(input: z.input<typeof ResolveMarketInput>) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!isAdmin(session)) {
    return { error: "Unauthorized" };
  }

  const parsed = ResolveMarketInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const { marketId, result } = parsed.data;

  const res = await fetch(`${API_BASE}/internal/resolve-market`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: marketId, result }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: (body as { error?: string })?.error ?? `Resolve failed (${res.status})` };
  }

  updateTag("markets");
  updateTag(`market:${marketId}`);
  updateTag("leaderboard");

  return { success: true };
}
