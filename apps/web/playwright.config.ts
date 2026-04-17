import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.E2E_PORT ?? "4103";
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DB_PATH = path.resolve(__dirname, "wpm-e2e.db");
const MAGIC_LINK_CAPTURE_PATH = path.resolve(__dirname, "wpm-e2e-magic-links.log");
const ORACLE_TOKEN = "test-oracle-token";

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
    command: `next dev --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: TEST_DB_PATH,
      BETTER_AUTH_SECRET: "test-secret-padding-32-bytes-long==",
      BETTER_AUTH_URL: BASE_URL,
      WPM_ORACLE_SERVICE_TOKEN: ORACLE_TOKEN,
      WPM_MAGIC_LINK_CAPTURE_PATH: MAGIC_LINK_CAPTURE_PATH,
      ADMIN_EMAILS: "admin@test.local",
    },
  },
});

export { BASE_URL, ORACLE_TOKEN, TEST_DB_PATH, MAGIC_LINK_CAPTURE_PATH };
