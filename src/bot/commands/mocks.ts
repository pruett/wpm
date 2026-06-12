// Stand-in data shaped like src/db/schema.ts rows. Every command reads from
// here until the drizzle layer is wired in — then this file disappears and
// commands query postgres instead.

export interface MockBet {
  id: number;
  marketTicker: string;
  outcome: string;
  side: "yes" | "no";
  contracts: number;
  priceCents: number;
  costCents: number;
  status: "open" | "won" | "lost" | "voided";
}

export const MOCK_BETS: MockBet[] = [
  {
    id: 1,
    marketTicker: "KXWCGAME-26JUN27PANENG-ENG",
    outcome: "England",
    side: "yes",
    contracts: 10,
    priceCents: 77,
    costCents: 770,
    status: "open",
  },
  {
    id: 2,
    marketTicker: "KXWCGAME-26JUN16USAPAR-TIE",
    outcome: "Tie",
    side: "no",
    contracts: 5,
    priceCents: 73,
    costCents: 365,
    status: "open",
  },
];

// Seed of $100,000.00 minus the two open bets above, as SUM(ledger.amount_cents) would derive.
export const MOCK_BALANCE_CENTS = 10_000_000 - 770 - 365;

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
