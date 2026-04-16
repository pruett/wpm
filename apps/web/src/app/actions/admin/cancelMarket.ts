"use server";

import { z } from "zod/v4";
import { requireAdmin, type ActionResult } from "@/lib/auth";
import { cancelMarket as cancelMarketCore } from "@/lib/market";

const CancelMarketInput = z.object({
  marketId: z.string().min(1),
});

export async function cancelMarket(
  input: z.input<typeof CancelMarketInput>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if ("error" in guard) return guard;

  const parsed = CancelMarketInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const result = cancelMarketCore(parsed.data.marketId, "admin_cancel");
  if (result.cancelled) return { success: true };
  return { error: result.reason };
}
