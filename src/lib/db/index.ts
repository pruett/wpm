import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wpm";

export const client = postgres(connectionString);

export const db = drizzle(client, { schema });

// Direct (non-pooled) Postgres URL for the realtime bus's `LISTEN` connection.
// PgBouncer transaction-mode silently drops LISTEN registrations, so the bus
// must bypass any pooler. No fallback to `DATABASE_URL` — the bus fails fast
// at init if this is unset. Neon/Vercel set this automatically.
export const directConnectionString = process.env.DATABASE_URL_UNPOOLED;
