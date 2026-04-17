import path from "node:path";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index";

export function runMigrations(): void {
  const migrationsFolder =
    process.env.WPM_MIGRATIONS_DIR ?? path.resolve(process.cwd(), "src/lib/db/migrations");
  drizzleMigrate(db, { migrationsFolder });
}
