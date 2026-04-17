"use server";

import { updateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { calculateOdds } from "@wpm/shared";
import { requireAdmin, type ActionResult } from "@/lib/auth";
import { db } from "@/lib/db";
import { ammPools, markets } from "@/lib/db/schema";
import { publish } from "@/lib/realtime/bus";

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
  const { marketId, seedA, seedB } = parsed.data;

  const reserveA = Math.round(seedA);
  const reserveB = Math.round(seedB);

  try {
    const liquidity = db.transaction((tx) => {
      const market = tx.select().from(markets).where(eq(markets.id, marketId)).get();
      if (!market) throw new Error("Market not found");

      const pool = tx.select().from(ammPools).where(eq(ammPools.marketId, marketId)).get();
      if (!pool) throw new Error("AMM pool missing");

      tx.update(ammPools).set({ reserveA, reserveB }).where(eq(ammPools.marketId, marketId)).run();

      return pool.wpmReserve;
    });

    const odds = calculateOdds({
      marketId,
      sharesA: reserveA,
      sharesB: reserveB,
      k: reserveA * reserveB,
      liquidity,
    });
    updateTag(`market:${marketId}`);

    publish({ type: "price:update", marketId, ...odds });

    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Override failed" };
  }
}
