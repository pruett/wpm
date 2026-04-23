"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod/v4";

import { requireAdmin, type ActionResult } from "@/data/auth";
import { resolveMarket as resolveMarketDAL } from "@/data/markets";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

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

  try {
    const result = await resolveMarketDAL(parsed.data.marketId, parsed.data.result);
    if (!result.resolved) return { error: result.reason };

    revalidateTag(tags.market(parsed.data.marketId), "max");
    revalidateTag(tags.marketsAll(), "max");
    revalidateTag(tags.leaderboard(), "max");
    for (const u of result.affectedUsers) {
      revalidateTag(tags.viewer(u.userId), "max");
    }

    emit.marketResolved(parsed.data.marketId, parsed.data.result);
    for (const u of result.affectedUsers) {
      emit.balanceUpdate(u.userId, u.newBalance);
    }

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Resolve failed" };
  }
}
