import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const DB_PATH = process.env.DATABASE_URL ?? "./wpm.db";

export const sqlite = new Database(DB_PATH);
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
