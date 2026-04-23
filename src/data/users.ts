import "server-only";
import { desc, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";

import { db } from "@/lib/db";
import { balances, user } from "@/lib/db/schema";

import { tags } from "./tags";

export type UserEntry = {
  userId: string;
  name: string;
  balance: number;
};

export async function getUsers(): Promise<UserEntry[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.users());

  return db
    .select({ userId: user.id, name: user.name, balance: balances.amount })
    .from(user)
    .innerJoin(balances, eq(balances.userId, user.id))
    .orderBy(desc(balances.amount));
}
