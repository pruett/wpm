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

/** Menus only offer events kicking off within this window (see upcomingEvents). */
export const BETTABLE_HORIZON_MS = 2 * 24 * 60 * 60 * 1000;
// Mirror slightly past the bettable window so an event's row and prices are
// already in Postgres by the time it first becomes visible in menus.
const SYNC_LEAD_MS = 6 * 60 * 60 * 1000;

export interface SeriesSyncStats {
  series: string;
  events: number;
  markets: number;
  skippedEvents: number;
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
 *
 * Kalshi's events endpoint has no kickoff filter (start times live on
 * milestones), so the full open list always comes over the wire — but only
 * events starting within the bettable horizon are written to Postgres.
 * Later events are picked up once they drift into the window. The one
 * exception: an already-mirrored event whose row is menu-visible (kickoff
 * within the horizon) stays updated even when Kalshi now says it starts
 * later — a postponed game must not keep its stale kickoff in the menu.
 */
export async function sync(seriesTicker: string): Promise<SeriesSyncStats> {
  const { events: kalshiEvents, milestones } = await ingestEvents(seriesTicker, {
    status: "open",
  });
  const milestoneByEvent = indexMilestones(milestones);

  const mirrored = new Map(
    (
      await db
        .select({ eventTicker: events.eventTicker, startsAt: events.startsAt })
        .from(events)
        .where(eq(events.seriesTicker, seriesTicker))
    ).map((r) => [r.eventTicker, r.startsAt]),
  );
  const horizon = new Date(Date.now() + BETTABLE_HORIZON_MS + SYNC_LEAD_MS);

  // A mirrored row whose stored kickoff is unknown or inside the horizon
  // could be showing in menus — keep it updated even if Kalshi now puts its
  // start beyond the horizon. Rows already stored as far-future are
  // invisible to menus, so they can wait with the rest.
  const menuVisible = (eventTicker: string): boolean => {
    if (!mirrored.has(eventTicker)) return false;
    const storedStart = mirrored.get(eventTicker);
    return storedStart == null || storedStart <= horizon;
  };

  let eventCount = 0;
  let marketCount = 0;
  let skippedEvents = 0;
  let settledBets = 0;
  let voidedBets = 0;

  for (const event of kalshiEvents) {
    const milestone = milestoneByEvent.get(event.event_ticker);
    const startsAt = date(milestone?.start_date);
    // Unknown start counts as in-horizon — only skip what we know is far out.
    const beyondHorizon = startsAt != null && startsAt > horizon;
    if (beyondHorizon && !menuVisible(event.event_ticker)) {
      skippedEvents++;
      continue;
    }

    await upsertEvent(event, milestone);
    eventCount++;
    if (beyondHorizon) continue; // row kept honest; markets can wait

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
    events: eventCount,
    markets: marketCount,
    skippedEvents,
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
