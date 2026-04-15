import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

function env(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const db = new Database(env("DATABASE_PATH", "data/wpm.db"));

export const auth = betterAuth({
  baseURL: env("BETTER_AUTH_URL", "http://localhost:4102"),
  secret: env("BETTER_AUTH_SECRET", "dev-secret-change-me-in-production"),
  database: db,
});
