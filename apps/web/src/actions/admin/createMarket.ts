"use server";

import { initializePool, type CreateMarketRequest } from "@wpm/shared";
import { revalidateTag } from "next/cache";
import { z } from "zod/v4";

import { requireAdmin, type ActionResult } from "@/data/auth";
import { createMarket as createMarketDAL } from "@/data/markets";
import { tags } from "@/data/tags";

const CreateMarketInput = z.object({
  id: z.string().min(1),
  sport: z.string().min(1),
  name: z.string().min(1),
  teamA: z.string().min(1),
  teamB: z.string().min(1),
  logoA: z.string().optional(),
  logoB: z.string().optional(),
  leagueLogo: z.string().optional(),
  startTime: z.iso.datetime(),
  bettingClosesAt: z.iso.datetime(),
  seedAmount: z.number().positive(),
  initialProbabilityA: z.number().min(0).max(1).optional(),
});

export async function createMarket(
  input: z.input<typeof CreateMarketInput>,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if ("error" in guard) return guard;

  const parsed = CreateMarketInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { id, seedAmount, initialProbabilityA } = parsed.data;
  const pool = initializePool(id, seedAmount, initialProbabilityA);

  const req: CreateMarketRequest = {
    ...parsed.data,
    reserveA: pool.sharesA,
    reserveB: pool.sharesB,
    wpmReserve: pool.liquidity,
  };

  try {
    const result = await createMarketDAL(req);
    if (!result.created) return { error: result.reason };

    revalidateTag(tags.marketsAll(), "max");

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Create failed" };
  }
}
