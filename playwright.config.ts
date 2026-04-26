import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = "http://localhost:3001";
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://wpm:wpm@localhost:5433/wpm_test";
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
    command: "next dev --port 3001",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      BETTER_AUTH_URL: BASE_URL,
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});

export { BASE_URL, TEST_DATABASE_URL, MAGIC_LINK_CAPTURE_PATH };
