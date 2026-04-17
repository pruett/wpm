import fs from "node:fs";
import { MAGIC_LINK_CAPTURE_PATH, TEST_DB_PATH } from "../../playwright.config";

export default async function globalSetup() {
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  if (fs.existsSync(MAGIC_LINK_CAPTURE_PATH)) fs.rmSync(MAGIC_LINK_CAPTURE_PATH);

  process.env.DATABASE_URL = TEST_DB_PATH;
  const { bootstrapDb } = await import("../../src/lib/db/bootstrap");
  bootstrapDb();
}
