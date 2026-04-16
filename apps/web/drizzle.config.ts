import type { Config } from "drizzle-kit";

export default {
  schema: "./src/lib/db/schema",
  out: "./src/lib/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "./wpm.db",
  },
} satisfies Config;
