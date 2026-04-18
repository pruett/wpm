"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod/v4";
import { requireAdmin, type ActionResult } from "@/data/auth";
import { distributeTokens as distributeTokensDAL } from "@/data/treasury";
import { tags } from "@/data/tags";
import { emit } from "@/lib/events/emit";

const DistributeInput = z.object({
  userId: z.string().min(1),
  amount: z.number().positive(),
});

export async function distributeTokens(
  input: z.input<typeof DistributeInput>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if ("error" in guard) return guard;

  const parsed = DistributeInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const { userId, newBalance } = await distributeTokensDAL(
      parsed.data.userId,
      parsed.data.amount,
    );

    revalidateTag(tags.users(), "max");
    revalidateTag(tags.viewer(userId), "max");
    revalidateTag(tags.leaderboard(), "max");

    emit.balanceUpdate(userId, newBalance);

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Distribution failed" };
  }
}
