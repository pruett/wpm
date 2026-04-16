"use server";

import { z } from "zod/v4";
import { requireAdmin, type ActionResult } from "@/lib/auth";
import { resolveMarket as resolveMarketCore } from "@/lib/market";

const ResolveMarketInput = z.object({
  marketId: z.string().min(1),
  result: z.enum(["A", "B"]),
});

export async function resolveMarket(
  input: z.input<typeof ResolveMarketInput>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if ("error" in guard) return guard;

  const parsed = ResolveMarketInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const result = resolveMarketCore(parsed.data.marketId, parsed.data.result);
  if (result.resolved) return { success: true };
  return { error: result.reason };
}
