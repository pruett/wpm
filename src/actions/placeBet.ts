"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod/v4";

import { type ActionResult } from "@/data/auth";
import { tags } from "@/data/tags";
import { placeBet as placeBetDAL } from "@/data/trading";

const PlaceBetInput = z.object({
  marketId: z.string().min(1),
  amount: z.number().positive(),
});

export async function placeBet(input: z.input<typeof PlaceBetInput>): Promise<ActionResult> {
  const parsed = PlaceBetInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const result = await placeBetDAL(parsed.data);

    revalidateTag(tags.market(result.marketId), "max");
    revalidateTag(tags.viewer(result.userId), "max");

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Bet failed" };
  }
}
