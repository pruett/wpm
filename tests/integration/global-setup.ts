import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default async function globalSetup() {
  const dbUrl = process.env.DATABASE_URL ?? "postgres://wpm:wpm@localhost:5433/wpm_integration";
  const url = new URL(dbUrl);
  const database = url.pathname.slice(1);
  url.pathname = "/postgres";

  const admin = postgres(url.toString());
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  execSync("bunx drizzle-kit migrate", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl, TMPDIR: "/private/tmp/claude-501" },
    stdio: "inherit",
  });
}
