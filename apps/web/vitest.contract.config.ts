import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.contract.test.ts", "tests/contract/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "tests/e2e/**"],
  },
});
