import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = "http://localhost:3000";
const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://wpm:wpm@localhost:5432/wpm";
const MAGIC_LINK_CAPTURE_PATH = path.resolve(__dirname, "wpm-e2e-magic-links.log");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders: {
      "content-type": "application/json",
    },
  },
  webServer: {
    command: "next dev --port 3000",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

export { BASE_URL, TEST_DATABASE_URL, MAGIC_LINK_CAPTURE_PATH };
