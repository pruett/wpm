#!/usr/bin/env bun
/**
 * WPM admin CLI — dev-only convenience tool.
 *
 * Drives the local node + API directly. Personas are cached at
 * ~/.wpm-admin/personas.json and shared with the browser dev-persona switcher
 * so that switching personas in the CLI also lights them up in the web UI.
 *
 * Usage: bun scripts/admin.ts <command> [args]
 *        bun scripts/admin.ts help
 *
 * Env: NODE_URL (default http://localhost:4100), API_URL (default http://localhost:4101)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NODE_URL = process.env.NODE_URL ?? "http://localhost:4100";
const API_URL = process.env.API_URL ?? "http://localhost:4101";

const STORE_DIR = join(homedir(), ".wpm-admin");
const PERSONAS_FILE = join(STORE_DIR, "personas.json");

type Persona = {
  name: string;
  email: string;
  token: string;
  address: string;
};

type Market = {
  id: string;
  name: string;
  outcomes: [string, string];
  closesAt: string;
  status: "open" | "closed" | "resolved" | "cancelled";
  result?: "A" | "B";
};

type AMMPool = {
  marketId: string;
  sharesA: number;
  sharesB: number;
  liquidity: number;
};

type SharePosition = {
  owner: string;
  marketId: string;
  outcome: "A" | "B";
  shares: number;
  costBasis: number;
};

// ---------- persona store ----------

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

function findPersona(email: string): Persona {
  const p = loadPersonas().find((x) => x.email === email);
  if (!p) {
    throw new Error(`No persona for ${email}. Add with: persona add <name> ${email}`);
  }
  return p;
}

// ---------- http helpers ----------

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

// ---------- arg helpers ----------

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}

function must(value: string | undefined, label: string): string {
  if (value === undefined || value === "") {
    throw new Error(`Missing argument: ${label}`);
  }
  return value;
}

function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`Bad duration "${s}" (use e.g. 30m, 2h, 1d)`);
  const n = Number(m[1]);
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * mult;
}

function parseOutcome(s: string | undefined): "A" | "B" {
  if (s === "A" || s === "B") return s;
  throw new Error(`Outcome must be "A" or "B", got "${s}"`);
}

// ---------- persona commands ----------

async function personaAdd(name: string, email: string): Promise<void> {
  const res = await http<{ token: string; address: string; balance: number }>(
    `${API_URL}/api/register`,
    { method: "POST", body: JSON.stringify({ name, email }) },
  );
  const personas = loadPersonas().filter((p) => p.email !== email);
  personas.push({ name, email, token: res.token, address: res.address });
  savePersonas(personas);
  console.log(`added ${name} <${email}>`);
  console.log(`  address: ${res.address}`);
  console.log(`  balance: ${res.balance.toLocaleString()} WPM`);
}

async function personaList(): Promise<void> {
  const personas = loadPersonas();
  if (personas.length === 0) {
    console.log("(no personas) — add one with: persona add <name> <email>");
    return;
  }
  for (const p of personas) {
    let bal = "?";
    try {
      const r = await http<{ balance: number }>(`${NODE_URL}/internal/balance/${p.address}`);
      bal = r.balance.toLocaleString();
    } catch {
      bal = "unreachable";
    }
    console.log(`${p.name.padEnd(18)} ${p.email.padEnd(28)} ${bal.padStart(12)} WPM`);
  }
}

function personaRemove(email: string): void {
  const before = loadPersonas();
  const after = before.filter((p) => p.email !== email);
  if (before.length === after.length) {
    console.log(`no persona for ${email}`);
    return;
  }
  savePersonas(after);
  console.log(`removed ${email}`);
}

async function personaFund(email: string, amountStr: string): Promise<void> {
  const p = findPersona(email);
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Bad amount: ${amountStr}`);
  }
  await http(`${NODE_URL}/internal/distribute`, {
    method: "POST",
    body: JSON.stringify({
      recipient: p.address,
      amount,
      reason: "admin_topup",
    }),
  });
  console.log(`distributed ${amount.toLocaleString()} WPM to ${email}`);
}

// ---------- market commands ----------

async function marketCreate(args: string[]): Promise<void> {
  const id = must(args[0], "id");
  const name = must(args[1], "name");
  const outcomeA = must(args[2], "outcomeA");
  const outcomeB = must(args[3], "outcomeB");
  const seed = Number(flag(args, "seed") ?? "1000");
  const closesIn = parseDuration(flag(args, "closes-in") ?? "1h");
  const closesAt = new Date(Date.now() + closesIn).toISOString();

  await http(`${NODE_URL}/internal/create-market`, {
    method: "POST",
    body: JSON.stringify({
      id,
      name,
      outcomes: [outcomeA, outcomeB],
      closesAt,
      seedAmount: seed,
    }),
  });
  console.log(`created market ${id}`);
  console.log(`  name: ${name}`);
  console.log(`  outcomes: A=${outcomeA}, B=${outcomeB}`);
  console.log(`  seed: ${seed.toLocaleString()} WPM`);
  console.log(`  closes: ${closesAt}`);
}

async function marketList(): Promise<void> {
  const raw = await http<Array<{ market: Market; pool: AMMPool }>>(`${NODE_URL}/internal/markets`);
  if (raw.length === 0) {
    console.log("(no markets)");
    return;
  }
  for (const { market, pool } of raw) {
    const status = market.status === "resolved" ? `resolved=${market.result}` : market.status;
    console.log(
      `${market.id.padEnd(24)} ${market.name.padEnd(32)} ${status.padEnd(14)} liq=${pool.liquidity}`,
    );
  }
}

async function marketResolve(id: string, resultStr: string): Promise<void> {
  const result = parseOutcome(resultStr);
  await http(`${NODE_URL}/internal/resolve-market`, {
    method: "POST",
    body: JSON.stringify({ id, result }),
  });
  console.log(`resolved ${id} -> ${result}`);
}

async function marketBettors(id: string): Promise<void> {
  const positions = await http<SharePosition[]>(`${NODE_URL}/internal/positions/market/${id}`);
  if (positions.length === 0) {
    console.log("(no positions)");
    return;
  }
  // Try to enrich with persona names
  const personas = loadPersonas();
  const byAddress = new Map(personas.map((p) => [p.address, p.name] as const));
  for (const pos of positions) {
    const name = byAddress.get(pos.owner) ?? `${pos.owner.slice(0, 10)}...`;
    console.log(
      `${name.padEnd(18)} outcome=${pos.outcome} shares=${pos.shares.toString().padStart(8)} cost=${pos.costBasis}`,
    );
  }
}

// ---------- bet/sell commands ----------

async function bet(
  email: string,
  marketId: string,
  outcomeStr: string,
  amountStr: string,
): Promise<void> {
  const p = findPersona(email);
  const outcome = parseOutcome(outcomeStr);
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Bad amount: ${amountStr}`);
  }
  await http(`${API_URL}/api/bet`, {
    method: "POST",
    auth: p.token,
    body: JSON.stringify({ marketId, outcome, amount }),
  });
  console.log(`${email} bet ${amount} on ${outcome} in ${marketId}`);
}

async function sell(
  email: string,
  marketId: string,
  outcomeStr: string,
  sharesStr: string,
): Promise<void> {
  const p = findPersona(email);
  const outcome = parseOutcome(outcomeStr);
  const shares = Number(sharesStr);
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error(`Bad shares: ${sharesStr}`);
  }
  await http(`${API_URL}/api/sell`, {
    method: "POST",
    auth: p.token,
    body: JSON.stringify({ marketId, outcome, shares }),
  });
  console.log(`${email} sold ${shares} of ${outcome} in ${marketId}`);
}

// ---------- help ----------

const HELP = `WPM admin CLI

  persona add <name> <email>            register a persona (auto-airdrops 100k WPM)
  persona list                          list cached personas + balances
  persona remove <email>                remove a persona from the local cache
  persona fund <email> <amount>         distribute additional WPM to a persona

  market create <id> <name> <outA> <outB> [--seed N] [--closes-in 1h]
                                        create a new market (default seed 1000, closes in 1h)
  market list                           list all markets
  market resolve <id> <A|B>             resolve a market (runs settlement)
  market bettors <id>                   show all positions in a market

  bet <email> <market-id> <A|B> <amount>     place a bet as a persona
  sell <email> <market-id> <A|B> <shares>    sell shares as a persona

Env:
  NODE_URL=${NODE_URL}
  API_URL=${API_URL}

Personas cached at: ${PERSONAS_FILE}
`;

// ---------- dispatch ----------

async function main(): Promise<void> {
  const [, , cmd, ...tail] = process.argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  // Top-level commands without subcommands
  if (cmd === "bet") {
    await bet(
      must(tail[0], "email"),
      must(tail[1], "market-id"),
      must(tail[2], "outcome"),
      must(tail[3], "amount"),
    );
    return;
  }
  if (cmd === "sell") {
    await sell(
      must(tail[0], "email"),
      must(tail[1], "market-id"),
      must(tail[2], "outcome"),
      must(tail[3], "shares"),
    );
    return;
  }

  // Two-word commands: <noun> <verb> [args]
  const sub = tail[0];
  const rest = tail.slice(1);
  switch (`${cmd} ${sub ?? ""}`.trim()) {
    case "persona add":
      await personaAdd(must(rest[0], "name"), must(rest[1], "email"));
      return;
    case "persona list":
      await personaList();
      return;
    case "persona remove":
      personaRemove(must(rest[0], "email"));
      return;
    case "persona fund":
      await personaFund(must(rest[0], "email"), must(rest[1], "amount"));
      return;

    case "market create":
      await marketCreate(rest);
      return;
    case "market list":
      await marketList();
      return;
    case "market resolve":
      await marketResolve(must(rest[0], "id"), must(rest[1], "result"));
      return;
    case "market bettors":
      await marketBettors(must(rest[0], "id"));
      return;
  }

  console.error(`Unknown command: ${cmd} ${sub ?? ""}`);
  console.error(`Run 'bun scripts/admin.ts help' for usage.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
