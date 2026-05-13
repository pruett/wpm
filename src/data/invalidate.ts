import "server-only";
import { sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";

import { db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function invalidate(tag: string, tx?: Tx): Promise<void> {
  revalidateTag(tag, "max");
  const conn = tx ?? db;
  await conn.execute(sql`SELECT pg_notify('wpm_invalidations', ${tag})`);
}
