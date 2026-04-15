"use server";

import { headers } from "next/headers";
import { updateTag } from "next/cache";
import { z } from "zod/v4";
import { auth, isAdmin } from "@/lib/auth";

const API_BASE = process.env.WPM_API_URL ?? "http://localhost:4101";

const OverrideSeedInput = z.object({
  marketId: z.string().min(1),
  seedA: z.number().positive(),
  seedB: z.number().positive(),
});

export async function overrideSeed(input: z.input<typeof OverrideSeedInput>) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!isAdmin(session)) {
    return { error: "Unauthorized" };
  }

  const parsed = OverrideSeedInput.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message };
  }

  const { marketId, seedA, seedB } = parsed.data;

  const res = await fetch(`${API_BASE}/internal/override-seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: marketId, seedA, seedB }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: (body as { error?: string })?.error ?? `Override failed (${res.status})` };
  }

  updateTag(`market:${marketId}`);

  return { success: true };
}
