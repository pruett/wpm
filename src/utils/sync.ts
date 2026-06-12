import type { EventData, Market, Milestone } from "kalshi-typescript";
import { db } from "../db";
import { events, markets } from "../db/schema";
import { settleMarketBets, voidMarketBets } from "./house";
import { ingestEvents } from "../kalshi/ingest";

// The SDK exposes prices only as dollar strings ("0.0900") — convert to integer cents.
const cents = (dollars?: string | null): number | null =>
  dollars == null || dollars === "" ? null : Math.round(parseFloat(dollars) * 100);

const date = (iso?: string | null): Date | null => (iso ? new Date(iso) : null);

/**
 * Pull all events for a series from Kalshi, mirror them into Postgres,
 * snapshot prices, and settle (or void) any bets whose market now has a
 * result. This is the single unit of work the cron runs: upsert markets,
 * then apply settlement wherever a terminal result appeared. Settlement
 * is idempotent — it only touches bets still marked open.
 */
export async function sync(seriesTicker: string) {
  const { events: kalshiEvents, milestones } = await ingestEvents(seriesTicker);
  const milestoneByEvent = indexMilestones(milestones);

  let marketCount = 0;
  let settledBets = 0;
  let voidedBets = 0;

  for (const event of kalshiEvents) {
    await upsertEvent(event, milestoneByEvent.get(event.event_ticker));
    for (const market of event.markets ?? []) {
      await upsertMarket(event, market);
      marketCount++;
      // The SDK types result as yes/no/scalar/"", but Kalshi documents
      // "void" for cancelled events — handle it defensively.
      const result = (market.result ?? "") as string;
      if (result === "yes" || result === "no") {
        settledBets += await settleMarketBets(market.ticker, result);
      } else if (result === "void") {
        voidedBets += await voidMarketBets(market.ticker);
      }
    }
  }

  return { events: kalshiEvents.length, markets: marketCount, settledBets, voidedBets };
}

// A milestone covers several related events (game, spread, total, …).
// Prefer one carrying a live game state in details.status.
function indexMilestones(milestones: Milestone[]): Map<string, Milestone> {
  const byEvent = new Map<string, Milestone>();
  for (const milestone of milestones) {
    for (const ticker of milestone.primary_event_tickers ?? []) {
      const existing = byEvent.get(ticker);
      if (!existing || (milestone.details?.status && !existing.details?.status)) {
        byEvent.set(ticker, milestone);
      }
    }
  }
  return byEvent;
}

async function upsertEvent(event: EventData, milestone?: Milestone) {
  const startsAt = date(milestone?.start_date);
  const gameStatus = (milestone?.details?.status as string | undefined) ?? "";

  await db
    .insert(events)
    .values({
      eventTicker: event.event_ticker,
      seriesTicker: event.series_ticker,
      title: event.title,
      mutuallyExclusive: event.mutually_exclusive,
      startsAt,
      gameStatus,
    })
    .onConflictDoUpdate({
      target: events.eventTicker,
      set: {
        title: event.title,
        mutuallyExclusive: event.mutually_exclusive,
        // Keep a previously known kickoff if this sync's milestone lacks one.
        ...(startsAt ? { startsAt } : {}),
        gameStatus,
        syncedAt: new Date(),
      },
    });
}

async function upsertMarket(event: EventData, market: Market) {
  const prices = {
    yesBid: cents(market.yes_bid_dollars),
    yesAsk: cents(market.yes_ask_dollars),
    noBid: cents(market.no_bid_dollars),
    noAsk: cents(market.no_ask_dollars),
    lastPrice: cents(market.last_price_dollars),
  };

  await db
    .insert(markets)
    .values({
      ticker: market.ticker,
      eventTicker: event.event_ticker,
      outcome: market.yes_sub_title,
      status: market.status,
      result: market.result ?? "",
      openTime: date(market.open_time),
      closeTime: new Date(market.close_time),
      expectedExpirationTime: date(market.expected_expiration_time),
      ...prices,
    })
    .onConflictDoUpdate({
      target: markets.ticker,
      set: {
        status: market.status,
        result: market.result ?? "",
        openTime: date(market.open_time),
        closeTime: new Date(market.close_time),
        expectedExpirationTime: date(market.expected_expiration_time),
        ...prices,
        syncedAt: new Date(),
      },
    });

}
