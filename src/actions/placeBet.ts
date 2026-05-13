"use server";

import { z } from "zod/v4";

import { type ActionResult } from "@/data/auth";
import { placeBet as placeBetDAL } from "@/data/trading";

const PlaceBetInput = z.object({
  marketId: z.string().min(1),
  amount: z.number().positive(),
});

export async function placeBet(input: z.input<typeof PlaceBetInput>): Promise<ActionResult> {
  const parsed = PlaceBetInput.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    await placeBetDAL(parsed.data);
    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Bet failed" };
  }
}
