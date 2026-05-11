import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "tests/integration/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "tests/e2e/**", "**/*.contract.test.ts"],
  },
});
