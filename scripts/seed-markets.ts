/**
 * Seed dummy markets for local testing.
 *
 * Usage:
 *   npx tsx scripts/seed-markets.ts
 *
 * Requires the node server running on NODE_URL (default http://localhost:4100).
 */

const NODE_URL = process.env.NODE_URL ?? "http://localhost:4100";
const SEED_AMOUNT = 1_000;

type DummyMarket = {
  id: string;
  name: string;
  outcomes: [string, string];
  closesAt: string;
};

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

function daysFromNow(d: number): string {
  return hoursFromNow(d * 24);
}

const markets: DummyMarket[] = [
  // --- Sports ---
  {
    id: "nfl-test-kc-buf",
    name: "Chiefs vs Bills",
    outcomes: ["Chiefs", "Bills"],
    closesAt: daysFromNow(3),
  },
  {
    id: "nfl-test-sf-phi",
    name: "49ers vs Eagles",
    outcomes: ["49ers", "Eagles"],
    closesAt: daysFromNow(3),
  },
  {
    id: "nba-test-lal-bos",
    name: "Lakers vs Celtics",
    outcomes: ["Lakers", "Celtics"],
    closesAt: daysFromNow(2),
  },
  {
    id: "nba-test-gsw-den",
    name: "Warriors vs Nuggets",
    outcomes: ["Warriors", "Nuggets"],
    closesAt: daysFromNow(2),
  },
  {
    id: "mlb-test-nyy-lad",
    name: "Yankees vs Dodgers",
    outcomes: ["Yankees", "Dodgers"],
    closesAt: daysFromNow(5),
  },

  // --- Politics ---
  {
    id: "pol-potus-2028",
    name: "Will the incumbent party win the 2028 presidential election?",
    outcomes: ["Yes", "No"],
    closesAt: daysFromNow(30),
  },
  {
    id: "pol-fed-rate-cut",
    name: "Fed cuts rates at next FOMC meeting?",
    outcomes: ["Cut", "Hold"],
    closesAt: daysFromNow(14),
  },

  // --- Crypto / Tech ---
  {
    id: "crypto-btc-100k",
    name: "Bitcoin above $100k by end of month?",
    outcomes: ["Yes", "No"],
    closesAt: daysFromNow(5),
  },
  {
    id: "tech-apple-wwdc",
    name: "Apple announces new hardware at WWDC?",
    outcomes: ["Yes", "No"],
    closesAt: daysFromNow(60),
  },

  // --- Pop culture ---
  {
    id: "pop-oscars-best-pic",
    name: "Will a sci-fi film win Best Picture?",
    outcomes: ["Yes", "No"],
    closesAt: daysFromNow(90),
  },
  {
    id: "pop-album-no1",
    name: "Kendrick Lamar's next album debuts #1?",
    outcomes: ["Yes", "No"],
    closesAt: daysFromNow(45),
  },

  // --- Weather / misc ---
  {
    id: "wx-hottest-month",
    name: "Will this July break the global heat record?",
    outcomes: ["Yes", "No"],
    closesAt: daysFromNow(120),
  },
];

async function createMarket(m: DummyMarket) {
  const res = await fetch(`${NODE_URL}/internal/create-market`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...m, seedAmount: SEED_AMOUNT }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`  ✗ ${m.id}: ${res.status} — ${text}`);
    return false;
  }

  console.log(`  ✓ ${m.id} — ${m.name}`);
  return true;
}

async function main() {
  // Check node health first
  try {
    const health = await fetch(`${NODE_URL}/internal/health`);
    if (!health.ok) throw new Error(`status ${health.status}`);
  } catch {
    console.error(`Cannot reach node at ${NODE_URL}. Is it running?`);
    process.exit(1);
  }

  console.log(`Seeding ${markets.length} markets into ${NODE_URL}...\n`);

  let created = 0;
  for (const m of markets) {
    if (await createMarket(m)) created++;
  }

  console.log(`\nDone — ${created}/${markets.length} markets created.`);
}

main();
