"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod/v4";

import { type ActionResult } from "@/data/auth";
import { tags } from "@/data/tags";
import { sellShares as sellSharesDAL } from "@/data/trading";

const SellSharesInput = z.object({
  marketId: z.string().min(1),
  outcome: z.enum(["A", "B"]),
  shares: z.number().positive(),
});

export async function sellShares(input: z.input<typeof SellSharesInput>): Promise<ActionResult> {
  const parsed = SellSharesInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const result = await sellSharesDAL(parsed.data);

    revalidateTag(tags.market(result.marketId), "max");
    revalidateTag(tags.viewer(result.userId), "max");

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sell failed" };
  }
}
