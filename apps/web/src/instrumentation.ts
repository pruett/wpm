export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { runMigrations } = await import("./lib/db/migrate");
  runMigrations();

  const { seedTreasury } = await import("./lib/db/seed");
  seedTreasury();
}
