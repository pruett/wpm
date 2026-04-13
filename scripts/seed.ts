#!/usr/bin/env bun
/**
 * Seed script — creates test personas, markets, and betting activity.
 *
 * Usage: bun scripts/seed.ts
 *
 * Requires the node + API servers to be running.
 * Env: NODE_URL (default http://localhost:4100), API_URL (default http://localhost:4101)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:4100";
const API_URL = process.env.API_URL ?? "http://localhost:4101";

const STORE_DIR = join(homedir(), ".wpm-admin");
const PERSONAS_FILE = join(STORE_DIR, "personas.json");

type Persona = { name: string; email: string; token: string; address: string };

function loadPersonas(): Persona[] {
  if (!existsSync(PERSONAS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PERSONAS_FILE, "utf-8")) as Persona[];
  } catch {
    return [];
  }
}

function savePersonas(personas: Persona[]): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(PERSONAS_FILE, JSON.stringify(personas, null, 2));
}

async function http<T>(url: string, init?: RequestInit & { auth?: string }): Promise<T> {
  const headers: Record<string, string> = {
    ...((init?.headers ?? {}) as Record<string, string>),
  };
  if (init?.body) headers["Content-Type"] = "application/json";
  if (init?.auth) headers["Authorization"] = `Bearer ${init.auth}`;

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}\n${body}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- seed data ----------

const PERSONAS = [
  { name: "Alice", email: "alice@test.com" },
  { name: "Bob", email: "bob@test.com" },
  { name: "Charlie", email: "charlie@test.com" },
  { name: "Dana", email: "dana@test.com" },
];

function hours(n: number): string {
  return new Date(Date.now() + n * 3_600_000).toISOString();
}

function days(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

const MARKETS = [
  // NFL
  {
    id: "nfl-chiefs-ravens",
    name: "Chiefs vs Ravens",
    outcomes: ["Chiefs", "Ravens"] as [string, string],
    closesAt: days(3),
    seedAmount: 5000,
  },
  {
    id: "nfl-eagles-49ers",
    name: "Eagles vs 49ers",
    outcomes: ["Eagles", "49ers"] as [string, string],
    closesAt: days(4),
    seedAmount: 5000,
  },
  {
    id: "nfl-bills-cowboys",
    name: "Bills vs Cowboys",
    outcomes: ["Bills", "Cowboys"] as [string, string],
    closesAt: days(5),
    seedAmount: 3000,
  },

  // MLB
  {
    id: "mlb-dodgers-yankees",
    name: "Dodgers vs Yankees",
    outcomes: ["Dodgers", "Yankees"] as [string, string],
    closesAt: days(1),
    seedAmount: 4000,
  },
  {
    id: "mlb-braves-astros",
    name: "Braves vs Astros",
    outcomes: ["Braves", "Astros"] as [string, string],
    closesAt: days(2),
    seedAmount: 3000,
  },
  {
    id: "mlb-mets-padres",
    name: "Mets vs Padres",
    outcomes: ["Mets", "Padres"] as [string, string],
    closesAt: hours(18),
    seedAmount: 2500,
  },

  // PGA Golf
  {
    id: "golf-pga-masters-spieth",
    name: "Jordan Spieth wins the Masters?",
    outcomes: ["Yes", "No"] as [string, string],
    closesAt: days(7),
    seedAmount: 3000,
  },
  {
    id: "golf-pga-masters-scheffler",
    name: "Scottie Scheffler wins the Masters?",
    outcomes: ["Yes", "No"] as [string, string],
    closesAt: days(7),
    seedAmount: 4000,
  },
];

// Bets: [personaEmail, marketId, outcome, amount]
const BETS: [string, string, "A" | "B", number][] = [
  // Chiefs vs Ravens — heavy action, Chiefs-favored
  ["alice@test.com", "nfl-chiefs-ravens", "A", 2000],
  ["bob@test.com", "nfl-chiefs-ravens", "B", 800],
  ["charlie@test.com", "nfl-chiefs-ravens", "A", 1200],
  ["dana@test.com", "nfl-chiefs-ravens", "B", 500],

  // Eagles vs 49ers — close to even
  ["bob@test.com", "nfl-eagles-49ers", "A", 1500],
  ["alice@test.com", "nfl-eagles-49ers", "B", 1400],
  ["dana@test.com", "nfl-eagles-49ers", "A", 600],

  // Bills vs Cowboys — light action
  ["charlie@test.com", "nfl-bills-cowboys", "B", 700],
  ["dana@test.com", "nfl-bills-cowboys", "A", 400],

  // Dodgers vs Yankees — big game energy
  ["alice@test.com", "mlb-dodgers-yankees", "A", 3000],
  ["bob@test.com", "mlb-dodgers-yankees", "B", 2500],
  ["charlie@test.com", "mlb-dodgers-yankees", "A", 1000],

  // Braves vs Astros
  ["dana@test.com", "mlb-braves-astros", "B", 1200],
  ["alice@test.com", "mlb-braves-astros", "A", 800],

  // Mets vs Padres — light
  ["bob@test.com", "mlb-mets-padres", "A", 500],

  // Spieth to win — long shot, mostly "No"
  ["charlie@test.com", "golf-pga-masters-spieth", "A", 300],
  ["alice@test.com", "golf-pga-masters-spieth", "B", 1500],
  ["dana@test.com", "golf-pga-masters-spieth", "B", 800],

  // Scheffler to win — more balanced
  ["bob@test.com", "golf-pga-masters-scheffler", "A", 2000],
  ["alice@test.com", "golf-pga-masters-scheffler", "B", 1000],
  ["charlie@test.com", "golf-pga-masters-scheffler", "A", 700],
];

// ---------- main ----------

async function main(): Promise<void> {
  console.log("=== WPM Seed Script ===\n");

  // 1. Register personas
  console.log("--- Registering personas ---");
  const existing = loadPersonas();
  const personaMap = new Map(existing.map((p) => [p.email, p]));

  for (const { name, email } of PERSONAS) {
    if (personaMap.has(email)) {
      console.log(`  ${name} <${email}> already exists, skipping`);
      continue;
    }
    try {
      const res = await http<{ token: string; address: string; balance: number }>(
        `${API_URL}/api/register`,
        { method: "POST", body: JSON.stringify({ name, email }) },
      );
      personaMap.set(email, { name, email, token: res.token, address: res.address });
      console.log(`  ${name} <${email}> registered (${res.balance.toLocaleString()} WPM)`);
    } catch (err) {
      console.error(`  FAILED to register ${email}: ${err}`);
    }
  }

  // Save all personas
  savePersonas([...personaMap.values()]);

  // 2. Create markets
  console.log("\n--- Creating markets ---");
  for (const m of MARKETS) {
    try {
      await http(`${NODE_URL}/internal/create-market`, {
        method: "POST",
        body: JSON.stringify(m),
      });
      console.log(`  ${m.id} — "${m.name}" (seed: ${m.seedAmount})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        console.log(`  ${m.id} — already exists, skipping`);
      } else {
        console.error(`  FAILED ${m.id}: ${msg}`);
      }
    }
  }

  // 3. Place bets
  console.log("\n--- Placing bets ---");
  for (const [email, marketId, outcome, amount] of BETS) {
    const persona = personaMap.get(email);
    if (!persona) {
      console.error(`  SKIP: no persona for ${email}`);
      continue;
    }
    try {
      await http(`${API_URL}/api/bet`, {
        method: "POST",
        auth: persona.token,
        body: JSON.stringify({ marketId, outcome, amount }),
      });
      console.log(`  ${persona.name} bet ${amount} on ${outcome} in ${marketId}`);
    } catch (err) {
      console.error(
        `  FAILED ${persona.name} bet on ${marketId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // 4. Summary
  console.log("\n--- Summary ---");
  console.log(`  Personas: ${personaMap.size}`);
  console.log(`  Markets: ${MARKETS.length}`);
  console.log(`  Bets placed: ${BETS.length}`);
  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
