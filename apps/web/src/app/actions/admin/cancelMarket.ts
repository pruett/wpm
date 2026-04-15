"use server";

import { headers } from "next/headers";
import { updateTag } from "next/cache";
import { z } from "zod/v4";
import { auth, isAdmin } from "@/lib/auth";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

const CancelMarketInput = z.object({
  marketId: z.string().min(1),
});

export async function cancelMarket(input: z.input<typeof CancelMarketInput>) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!isAdmin(session)) {
    return { error: "Unauthorized" };
  }

  const parsed = CancelMarketInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const { marketId } = parsed.data;

  const res = await fetch(`${API_BASE}/internal/cancel-market`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: marketId }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: (body as { error?: string })?.error ?? `Cancel failed (${res.status})` };
  }

  updateTag("markets");
  updateTag(`market:${marketId}`);

  return { success: true };
}
