import { INITIAL_SUPPLY } from "@wpm/shared";
import { db } from "./index";
import { treasury } from "./schema";

/**
 * Seeds the singleton treasury row with INITIAL_SUPPLY.
 * Safe to call repeatedly: a pre-existing row is left untouched.
 */
export async function seedTreasury(): Promise<void> {
  await db
    .insert(treasury)
    .values({
      id: "treasury",
      amount: INITIAL_SUPPLY,
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
}
