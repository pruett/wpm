import { cacheLife, cacheTag } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { balances, user } from "@/lib/db/schema";

export type UserEntry = {
  userId: string;
  name: string;
  balance: number;
};

export async function getUsers(): Promise<UserEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag("users");

  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      balance: balances.amount,
    })
    .from(user)
    .innerJoin(balances, eq(balances.userId, user.id))
    .orderBy(desc(balances.amount));

  return rows;
}
