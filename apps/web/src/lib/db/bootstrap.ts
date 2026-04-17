import { runMigrations } from "./migrate";
import { seedTreasury } from "./seed";

export function bootstrapDb(): void {
  runMigrations();
  seedTreasury();
}

if (import.meta.main) {
  bootstrapDb();
}
