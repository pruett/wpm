import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { MAGIC_LINK_CAPTURE_PATH, TEST_DATABASE_URL } from "../../playwright.config";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function adminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function canQuery(databaseUrl: string): Promise<boolean> {
  const sql = postgres(databaseUrl, { connect_timeout: 2, max: 1, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

async function ensurePostgresRunning(databaseUrl: string) {
  const admin = adminUrl(databaseUrl);
  if (await canQuery(admin)) return;
  console.log("[e2e] postgres not reachable — starting via docker compose…");
  execSync("docker compose up -d wpm-test-db", { cwd: WEB_ROOT, stdio: "inherit" });
  for (let i = 0; i < 60; i++) {
    if (await canQuery(admin)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`postgres did not become query-ready for ${databaseUrl}`);
}

async function recreateDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const database = url.pathname.slice(1);
  const admin = postgres(adminUrl(databaseUrl));
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }
}

export default async function globalSetup() {
  if (fs.existsSync(MAGIC_LINK_CAPTURE_PATH)) fs.rmSync(MAGIC_LINK_CAPTURE_PATH);

  await ensurePostgresRunning(TEST_DATABASE_URL);
  await recreateDatabase(TEST_DATABASE_URL);

  execSync("bunx drizzle-kit migrate", {
    cwd: WEB_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "inherit",
  });

  process.env.DATABASE_URL = TEST_DATABASE_URL;
}
