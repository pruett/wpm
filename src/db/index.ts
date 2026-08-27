import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (e.g. postgres://localhost/wpm2)");

// Neon suspends its compute after 5 idle minutes and severs open connections
// without a goodbye. A warm Fluid instance holds this pool across cron runs,
// so the first query after a suspend would otherwise hit a dead socket. Close
// idle connections ourselves (the sweep finishes in ~1s, so 20s of quiet means
// we're done) and recycle even busy ones every 30 minutes.
export const sql = postgres(url, {
  idle_timeout: 20,
  max_lifetime: 60 * 30,
});
export const db = drizzle(sql, { schema });
