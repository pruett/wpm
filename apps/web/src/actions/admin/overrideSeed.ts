"use server";

import { calculateOdds } from "@wpm/shared";
import { revalidateTag } from "next/cache";
import { z } from "zod/v4";

import { requireAdmin, type ActionResult } from "@/data/auth";
import { overrideSeed as overrideSeedDAL } from "@/data/markets";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

const OverrideSeedInput = z.object({
  marketId: z.string().min(1),
  seedA: z.number().positive(),
  seedB: z.number().positive(),
});

export async function overrideSeed(
  input: z.input<typeof OverrideSeedInput>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if ("error" in guard) return guard;

  const parsed = OverrideSeedInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const { marketId } = parsed.data;
    const { reserveA, reserveB, liquidity } = await overrideSeedDAL(
      marketId,
      parsed.data.seedA,
      parsed.data.seedB,
    );

    const odds = calculateOdds({
      marketId,
      sharesA: reserveA,
      sharesB: reserveB,
      k: reserveA * reserveB,
      liquidity,
    });

    revalidateTag(tags.market(marketId), "max");

    emit.priceUpdate(marketId, odds);

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Override failed" };
  }
}
