import type { EventData, Market, Milestone } from "kalshi-typescript";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { bets, events, markets } from "../db/schema";
import { settleMarketBets, voidMarketBets } from "./house";
import { ingestEvents } from "../kalshi/ingest";
import { marketApi } from "../kalshi/client";
import { TRACKED_SERIES } from "../kalshi/series";

// The SDK exposes prices only as dollar strings ("0.0900") — convert to integer cents.
const cents = (dollars?: string | null): number | null =>
  dollars == null || dollars === "" ? null : Math.round(parseFloat(dollars) * 100);

const date = (iso?: string | null): Date | null => (iso ? new Date(iso) : null);

export interface SeriesSyncStats {
  series: string;
  events: number;
  markets: number;
  settledBets: number;
  voidedBets: number;
}

/**
 * Pull a series' live events from Kalshi, mirror them into Postgres,
 * snapshot prices, and settle (or void) any bets whose market now has a
 * result. Settlement is idempotent — it only touches bets still marked open.
 *
 * Only "open" events are swept: a series like KXNBAGAME carries the whole
 * season (1,400+ events), almost all settled history that menus never show.
 * Markets that leave the sweep with bets still riding are caught by
 * settleOpenBetMarkets.
 */
export async function sync(seriesTicker: string): Promise<SeriesSyncStats> {
  const { events: kalshiEvents, milestones } = await ingestEvents(seriesTicker, {
    status: "open",
  });
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

  return {
    series: seriesTicker,
    events: kalshiEvents.length,
    markets: marketCount,
    settledBets,
    voidedBets,
  };
}

/**
 * Settle markets that still carry open bets but have dropped out of the
 * open-event sweep (game over, event closed/settled on Kalshi). Looks up
 * exactly the markets our book cares about, in batches, and applies any
 * terminal result. Idempotent for the same reason sync is.
 */
export async function settleOpenBetMarkets() {
  const openMarkets = await db
    .selectDistinct({ ticker: bets.marketTicker })
    .from(bets)
    .where(eq(bets.status, "open"));

  let settledBets = 0;
  let voidedBets = 0;
  const BATCH = 50;

  for (let i = 0; i < openMarkets.length; i += BATCH) {
    const tickers = openMarkets.slice(i, i + BATCH).map((r) => r.ticker);
    const { data } = await marketApi.getMarkets(
      BATCH,
      undefined, // cursor
      undefined, // eventTicker
      undefined, // seriesTicker
      undefined, // minCreatedTs
      undefined, // maxCreatedTs
      undefined, // minUpdatedTs
      undefined, // maxCloseTs
      undefined, // minCloseTs
      undefined, // minSettledTs
      undefined, // maxSettledTs
      undefined, // status
      tickers.join(","),
    );
    for (const market of data.markets ?? []) {
      await updateMarketRow(market);
      const result = (market.result ?? "") as string;
      if (result === "yes" || result === "no") {
        settledBets += await settleMarketBets(market.ticker, result);
      } else if (result === "void") {
        voidedBets += await voidMarketBets(market.ticker);
      }
    }
  }

  return { checkedMarkets: openMarkets.length, settledBets, voidedBets };
}

/**
 * The full cron unit of work: mirror every tracked series, then sweep
 * markets with open bets for results the per-series sync no longer sees.
 */
export async function syncAll() {
  const series: SeriesSyncStats[] = [];
  for (const tracked of TRACKED_SERIES) {
    series.push(await sync(tracked.ticker));
  }
  const settlement = await settleOpenBetMarkets();
  return {
    series,
    checkedMarkets: settlement.checkedMarkets,
    // Totals across the per-series sweeps and the settlement pass.
    settledBets: series.reduce((n, s) => n + s.settledBets, settlement.settledBets),
    voidedBets: series.reduce((n, s) => n + s.voidedBets, settlement.voidedBets),
  };
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

function marketPrices(market: Market) {
  return {
    yesBid: cents(market.yes_bid_dollars),
    yesAsk: cents(market.yes_ask_dollars),
    noBid: cents(market.no_bid_dollars),
    noAsk: cents(market.no_ask_dollars),
    lastPrice: cents(market.last_price_dollars),
  };
}

// Refresh an already-mirrored market (settlement pass) — no event context
// needed, the row exists because a bet was placed on it.
async function updateMarketRow(market: Market) {
  await db
    .update(markets)
    .set({
      status: market.status,
      result: market.result ?? "",
      ...marketPrices(market),
      syncedAt: new Date(),
    })
    .where(eq(markets.ticker, market.ticker));
}

async function upsertMarket(event: EventData, market: Market) {
  const prices = marketPrices(market);

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
