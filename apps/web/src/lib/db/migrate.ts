import path from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index";

export async function runMigrations(): Promise<void> {
  const migrationsFolder =
    process.env.WPM_MIGRATIONS_DIR ?? path.resolve(process.cwd(), "src/lib/db/migrations");
  await drizzleMigrate(db, { migrationsFolder });
}
