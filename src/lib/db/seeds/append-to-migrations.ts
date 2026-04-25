import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { treasurySeedSql } from "./treasury";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const SEEDS = [
  {
    name: "treasury",
    detect: /CREATE TABLE "treasury"/,
    sql: treasurySeedSql,
  },
];

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

for (const file of files) {
  const path = join(MIGRATIONS_DIR, file);
  const original = readFileSync(path, "utf8");
  let updated = original;

  for (const seed of SEEDS) {
    if (!seed.detect.test(updated)) continue;
    if (updated.includes(seed.sql)) continue;
    const trimmed = updated.trimEnd();
    const breakpoint = "--> statement-breakpoint";
    const prefix = trimmed.endsWith(breakpoint) ? "" : `\n${breakpoint}`;
    updated = `${trimmed}${prefix}\n-- seed: ${seed.name}\n${seed.sql}\n`;
  }

  if (updated !== original) {
    writeFileSync(path, updated);
    console.log(`appended seeds to ${file}`);
  }
}
