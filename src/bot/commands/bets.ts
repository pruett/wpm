import type { ActionEvent, CardElement } from "chat";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "../../db";
import { bets as betsTable, events, markets, users } from "../../db/schema";
import { displayName, formatDollars } from "../../utils/format";
import type { BotCommand } from "./types";
import { groupBySeries, isNotModified, kickoffLabel, menuHandle, seriesHeaderRow, upcomingEvents } from "./bet";

// Action ids — the tapped event ticker travels in the button's value.
// Registered via bot.onAction in src/bot/index.ts.
export const BETS_PICK_EVENT_ACTION = "bets_event";
export const BETS_BACK_ACTION = "bets_back";

const BETS_FALLBACK = "Open bets (buttons not supported here).";

function betCountLabel(n: number): string {
  return n === 1 ? "1 bet" : `${n} bets`;
}

/** Open-bet counts per event, for the event-list buttons. */
async function openBetCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ eventTicker: markets.eventTicker, betCount: count(betsTable.id) })
    .from(betsTable)
    .innerJoin(markets, eq(markets.ticker, betsTable.marketTicker))
    .where(eq(betsTable.status, "open"))
    .groupBy(markets.eventTicker);
  return new Map(rows.map((r) => [r.eventTicker, Number(r.betCount)]));
}

// Same event list as /bet (shared via upcomingEvents and groupBySeries),
// but each button shows how many open bets ride on that event instead of
// the kickoff time.
async function betsEventsCard(): Promise<CardElement | null> {
  const rows = await upcomingEvents();
  if (rows.length === 0) return null;

  const counts = await openBetCounts();
  return {
    type: "card",
    children: [
      { type: "text", content: "Open bets by event", style: "bold" },
      ...groupBySeries(rows).flatMap((group) => [
        seriesHeaderRow(group.seriesTicker),
        ...group.events.map((e) => ({
          type: "actions" as const,
          children: [
            {
              type: "button" as const,
              id: BETS_PICK_EVENT_ACTION,
              label: `${e.title} — ${betCountLabel(counts.get(e.eventTicker) ?? 0)}`,
              value: e.eventTicker,
            },
          ],
        })),
      ]),
    ],
  };
}

// Drill-down: every open bet on the tapped event, oldest first, one line
// per bet. Returns null when the event ticker is unknown (stale button).
async function eventBetsCard(eventTicker: string): Promise<CardElement | null> {
  const [event] = await db
    .select({ title: events.title, startsAt: events.startsAt })
    .from(events)
    .where(eq(events.eventTicker, eventTicker))
    .limit(1);
  if (!event) return null;

  const rows = await db
    .select({
      outcome: markets.outcome,
      side: betsTable.side,
      contracts: betsTable.contracts,
      priceCents: betsTable.priceCents,
      costCents: betsTable.costCents,
      username: users.username,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(betsTable)
    .innerJoin(markets, eq(markets.ticker, betsTable.marketTicker))
    .innerJoin(users, eq(users.id, betsTable.userId))
    .where(and(eq(markets.eventTicker, eventTicker), eq(betsTable.status, "open")))
    .orderBy(asc(betsTable.id));

  const header =
    `${event.title} — ${kickoffLabel(event.startsAt)} — ` +
    `Ticker: ${eventTicker} — ${betCountLabel(rows.length)}`;

  const lines =
    rows.length === 0
      ? [{ type: "text" as const, content: "No open bets yet — type /bet to place the first one." }]
      : rows.map((bet, i) => ({
          type: "text" as const,
          content:
            `${i + 1}. ${displayName(bet)} — ${bet.outcome} ${bet.side.toUpperCase()}, ` +
            `${bet.contracts.toLocaleString("en-US")} shares @ ${bet.priceCents}¢ ` +
            `(cost ${formatDollars(bet.costCents)}, pays ${formatDollars(bet.contracts * 100)})`,
        }));

  return {
    type: "card",
    children: [
      { type: "text", content: header, style: "bold" },
      ...lines,
      {
        type: "actions",
        children: [{ type: "button" as const, id: BETS_BACK_ACTION, label: "← All events" }],
      },
    ],
  };
}

// The /bets card is a shared read-only view (unlike /bet's per-user menus),
// so any tapper may navigate it — there's no flow state to clobber.
async function showBetsView(event: ActionEvent, card: CardElement): Promise<void> {
  if (!event.thread) return;
  try {
    await menuHandle(event.thread, event.messageId).edit({ card, fallbackText: BETS_FALLBACK });
  } catch (err) {
    if (isNotModified(err)) return;
    await event.thread.post({ card, fallbackText: BETS_FALLBACK });
  }
}

// Event button tapped → card becomes that event's open-bet list.
export async function handleBetsPickEvent(event: ActionEvent): Promise<void> {
  if (!event.value) return;
  const card = (await eventBetsCard(event.value)) ?? (await betsEventsCard());
  if (card) await showBetsView(event, card);
}

// Back button tapped → card becomes the event list again.
export async function handleBetsBack(event: ActionEvent): Promise<void> {
  const card = await betsEventsCard();
  if (card) await showBetsView(event, card);
}

export const bets: BotCommand = {
  name: "bets",
  description: "See everyone's open bets by event",
  usage: "/bets",
  handler: async ({ thread }) => {
    const card = await betsEventsCard();
    if (!card) {
      await thread.post("No markets in the database yet — run a sync first.");
      return;
    }
    await thread.post({ card, fallbackText: BETS_FALLBACK });
  },
};
