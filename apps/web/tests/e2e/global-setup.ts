import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { MAGIC_LINK_CAPTURE_PATH, TEST_DATABASE_URL } from "../../playwright.config";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default async function globalSetup() {
  if (fs.existsSync(MAGIC_LINK_CAPTURE_PATH)) fs.rmSync(MAGIC_LINK_CAPTURE_PATH);

  const url = new URL(TEST_DATABASE_URL);
  const database = url.pathname.slice(1);
  url.pathname = "/postgres";
  const admin = postgres(url.toString());
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  execSync("bunx drizzle-kit push --force", {
    cwd: WEB_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });

  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const { bootstrapDb } = await import("../../src/lib/db/bootstrap");
  await bootstrapDb();
}
