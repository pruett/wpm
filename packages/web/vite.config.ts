import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, "../..", ""), ...loadEnv(mode, ".", "") };
  // Expose env vars to server-side process.env (for better-auth)
  for (const [key, value] of Object.entries(env)) {
    process.env[key] ??= value;
  }

  return {
    plugins: [tailwindcss(), sveltekit(), svelteTesting()],
    server: {
      proxy: {
        "/api/blocks": "http://localhost:4101",
        "/api/categories": "http://localhost:4101",
        "/api/markets": "http://localhost:4101",
        "/api/health": "http://localhost:4101",
        "/api/leaderboard": "http://localhost:4101",
        "/api/register": "http://localhost:4101",
        "/events": "http://localhost:4101",
      },
    },
    test: {
      environment: "jsdom",
      include: ["tests/**/*.test.ts"],
      setupFiles: ["tests/setup.ts"],
    },
  };
});
