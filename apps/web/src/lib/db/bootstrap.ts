import { client } from "./index";
import { seedTreasury } from "./seed";

export async function bootstrapDb(): Promise<void> {
  await seedTreasury();
}

if (import.meta.main) {
  await bootstrapDb();
  await client.end();
}
