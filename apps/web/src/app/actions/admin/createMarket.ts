"use server";

import { z } from "zod/v4";
import { initializePool, type CreateMarketRequest } from "@wpm/shared";
import { requireAdmin, type ActionResult } from "@/lib/auth";
import { createMarketAndNotify } from "@/lib/market";

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

  const result = createMarketAndNotify(req);
  if (result.created) return { success: true };
  return { error: result.reason };
}
