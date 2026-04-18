"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod/v4";
import { requireAdmin, type ActionResult } from "@/data/auth";
import { cancelMarket as cancelMarketDAL } from "@/data/markets";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

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

  try {
    const result = await cancelMarketDAL(parsed.data.marketId, "admin_cancel");
    if (!result.cancelled) return { error: result.reason };

    revalidateTag(tags.market(parsed.data.marketId), "max");
    revalidateTag(tags.marketsAll(), "max");
    revalidateTag(tags.leaderboard(), "max");
    for (const u of result.affectedUsers) {
      revalidateTag(tags.viewer(u.userId), "max");
    }

    for (const u of result.affectedUsers) {
      emit.balanceUpdate(u.userId, u.newBalance);
    }

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Cancel failed" };
  }
}
