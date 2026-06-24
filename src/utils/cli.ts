/**
 * Minimal CLI to exercise the house model end to end.
 *
 *   bun run cli sync [series]                          # mirror tracked series (or just one) → Postgres, settle results (the cron job)
 *   bun run cli markets <event_ticker>                 # show an event's outcomes and prices
 *   bun run cli register <telegram_id>                 # create a user with the seed bankroll
 *   bun run cli bet <telegram_id> <market> <yes|no> <$>  # bet against the house
 *   bun run cli balance <telegram_id>
 *   bun run cli bets <telegram_id>
 *   bun run cli settle <market> <yes|no>               # manual settle (testing only)
 *   bun run cli summary [post]                          # rehearse the weekly recap; "post" sends it to local groups
 *   bun run cli settlements [post]                      # rehearse the settlement roast; "post" claims + sends it
 */
import { asc, eq } from "drizzle-orm";
import { db, sql } from "../db";
import { bets, events, markets, users } from "../db/schema";
import { balanceCents, findUser, placeBet, registerUser, settleMarketBets, type BetSide } from "./house";
import {
  claimUnannouncedSettlements,
  peekUnannouncedSettlements,
  releaseAnnouncements,
  releaseBettableAlerts,
  settleOpenBetMarkets,
  sync,
  syncAll,
} from "./sync";
import {
  announceBettableAlerts,
  announceSettlements,
  announceWeeklyRecap,
  buildSettlementRecap,
} from "./announce";
import { collectWeeklyStats, generateWeeklyRecap, hadActivity } from "./summary";
import { displayName, formatDollars, formatEastern, linkMentions } from "./format";
import { TRACKED_SERIES } from "../kalshi/series";
import { state } from "../bot";

const dollars = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const [cmd, ...args] = Bun.argv.slice(2);

switch (cmd) {
  case "sync": {
    // No arg syncs every tracked series and recaps settlements in the
    // subscribed groups (what the cron does); an explicit series ticker
    // syncs just that one, quietly. Both end with the settlement pass.
    const { series, settledBets, voidedBets, bettableAlerts } = args[0]
      ? await (async () => {
          // Carry the tracked series' tournament filter (e.g. KXATPMATCH →
          // Wimbledon) so a single-series sync mirrors the same subset syncAll
          // does, not the whole pooled feed.
          const tracked = TRACKED_SERIES.find((s) => s.ticker === args[0]);
          const stats = await sync(args[0]!, tracked?.tournamentName);
          const settlement = await settleOpenBetMarkets();
          return {
            series: [stats],
            settledBets: stats.settledBets + settlement.settledBets,
            voidedBets: stats.voidedBets + settlement.voidedBets,
            bettableAlerts: [],
          };
        })()
      : await syncAll();
    for (const s of series) {
      console.log(
        `synced ${s.events} events / ${s.markets} markets from ${s.series}` +
          (s.skippedEvents ? ` (${s.skippedEvents} beyond horizon)` : ""),
      );
    }
    if (settledBets) console.log(`settled ${settledBets} bets`);
    if (voidedBets) console.log(`voided ${voidedBets} bets`);
    if (!args[0]) {
      // Announce from persisted state (same path as the cron) so a failed post
      // is retried next run instead of double-posted or lost.
      const claimed = await claimUnannouncedSettlements();
      if (claimed.claimedBetIds.length > 0) {
        const announced = await announceSettlements(claimed.settlements, claimed.voidedBets);
        if (announced) console.log(`announced settlements in ${announced} groups`);
        else await releaseAnnouncements(claimed.claimedBetIds);
      }
      const alerted = await announceBettableAlerts(bettableAlerts);
      if (alerted) console.log(`announced last-call alerts in ${alerted} groups`);
      else if (bettableAlerts.length)
        await releaseBettableAlerts(bettableAlerts.map((a) => a.eventTicker));
    }
    break;
  }

  case "markets": {
    const [event] = await db.select().from(events).where(eq(events.eventTicker, args[0]!));
    if (event) {
      console.log(
        `${event.title} — kickoff ${event.startsAt?.toISOString() ?? "unknown"} [${event.gameStatus || "no game status"}]`,
      );
    }
    const rows = await db
      .select()
      .from(markets)
      .where(eq(markets.eventTicker, args[0]!))
      .orderBy(asc(markets.ticker));
    for (const m of rows) {
      console.log(
        `${m.ticker}  ${m.outcome.padEnd(12)} yes ${dollars(m.yesAsk)}  no ${dollars(m.noAsk)}  [${m.status}]`,
      );
    }
    break;
  }

  case "bet": {
    const [telegramId, market, side, stake] = args;
    const bet = await placeBet(
      { telegramId: telegramId! },
      market!,
      side as BetSide,
      Math.round(parseFloat(stake!) * 100),
    );
    console.log(
      `bet #${bet.betId}: ${bet.contracts} contracts of ${market} ${side} @ ${bet.price}¢ — cost ${dollars(bet.cost)}, pays ${dollars(bet.contracts * 100)} on a win`,
    );
    break;
  }

  case "register": {
    const { userId, created } = await registerUser({ telegramId: args[0]! });
    console.log(created ? `registered user #${userId}` : `already registered as user #${userId}`);
    break;
  }

  case "balance": {
    const userId = await findUser({ telegramId: args[0]! });
    if (userId == null) {
      console.error(`no user with telegram id ${args[0]} — register first`);
      process.exit(1);
    }
    console.log(dollars(await balanceCents(userId)));
    break;
  }

  case "bets": {
    const rows = await db
      .select({
        id: bets.id,
        marketTicker: bets.marketTicker,
        side: bets.side,
        contracts: bets.contracts,
        priceCents: bets.priceCents,
        costCents: bets.costCents,
        status: bets.status,
      })
      .from(bets)
      .innerJoin(users, eq(users.id, bets.userId))
      .where(eq(users.telegramId, args[0]!))
      .orderBy(asc(bets.id));
    for (const b of rows) {
      console.log(
        `#${b.id} ${b.marketTicker} ${b.side} ×${b.contracts} @ ${b.priceCents}¢ (${dollars(b.costCents)}) — ${b.status}`,
      );
    }
    break;
  }

  case "settle": {
    const settled = await settleMarketBets(args[0]!, args[1] as BetSide);
    console.log(`settled ${settled.length} bets on ${args[0]} as ${args[1]}`);
    break;
  }

  case "summary": {
    // Rehearse the weekly "Sunday Rundown" recap against the local DB.
    //   bun run cli summary        # tally + generate, print it (posts nothing)
    //   bun run cli summary post   # also post to the LOCAL bot's subscribed groups
    // Pair with `bun run db:pull:prod` to rehearse on a copy of prod's bets
    // while posting only to your local test group (chat_* subscriptions stay local).
    const post = args[0] === "post";
    const stats = await collectWeeklyStats();
    console.log(`\nWeek of ${formatEastern(stats.since)} → ${formatEastern(stats.until)} (ET)\n`);

    if (!hadActivity(stats)) {
      console.log("No bets placed or settled this week — the cron would skip posting.");
      break;
    }

    console.log(
      `${stats.betsPlaced} bets placed (${formatDollars(stats.totalStakedCents)} wagered) · ` +
        `${stats.betsSettled} settled (${stats.wins}W ${stats.losses}L` +
        `${stats.voids ? ` ${stats.voids}V` : ""}) · ${stats.uniqueBettors} bettors\n`,
    );

    for (const p of stats.players) {
      const net = p.realizedCents;
      const netStr = `${net > 0 ? "+" : net < 0 ? "-" : " "}${formatDollars(Math.abs(net))}`;
      console.log(
        `  ${netStr.padStart(12)}  ${displayName(p.user).padEnd(20)} ` +
          `${p.wins}W-${p.losses}L${p.voids ? `-${p.voids}V` : ""}, ` +
          `placed ${p.betsPlaced} (${formatDollars(p.stakedCents)})`,
      );
    }

    console.log("\n─── recap ───\n");
    const recap = await generateWeeklyRecap(stats);
    console.log(recap.body);
    console.log(`\n─── (${recap.model}) ───\n`);

    if (post) {
      const mentioned = linkMentions(recap.body, stats.players.map((p) => p.user));
      const threads = await announceWeeklyRecap(mentioned);
      console.log(`Posted to ${threads} group${threads === 1 ? "" : "s"}.`);
    } else {
      console.log("(dry run — re-run with `summary post` to send it to your local groups.)");
    }
    break;
  }

  case "settlements": {
    // Rehearse the settlement trash-talk against the local DB.
    //   bun run cli settlements        # peek (no claim) + generate, print it — posts nothing
    //   bun run cli settlements post   # claim + post to the LOCAL bot's groups (the real cron path)
    // Pair with `bun run db:pull:prod` to rehearse on a copy of prod's settled
    // bets while posting only to your local test group (subscriptions stay local).
    const post = args[0] === "post";

    if (post) {
      const claimed = await claimUnannouncedSettlements();
      if (claimed.claimedBetIds.length === 0) {
        console.log("Nothing settled and unannounced — nothing to post.");
        break;
      }
      const threads = await announceSettlements(claimed.settlements, claimed.voidedBets);
      if (threads) {
        console.log(`Posted to ${threads} group${threads === 1 ? "" : "s"}.`);
      } else {
        // No group got it — release the claim so the next run retries (cron parity).
        await releaseAnnouncements(claimed.claimedBetIds);
        console.log("No groups posted — released the claim so it retries.");
      }
      break;
    }

    // Dry run: peek without claiming, so the real cron still has these to post.
    const peek = await peekUnannouncedSettlements();
    if (peek.settlements.length === 0 && peek.voidedBets === 0) {
      console.log("Nothing settled and unannounced — settle some bets first (cli sync / cli settle).");
      break;
    }

    const recap = await buildSettlementRecap(peek.settlements, peek.voidedBets);
    console.log("\n─── facts (fed to the model) ───\n");
    console.log(recap.facts);
    console.log("\n─── recap ───\n");
    console.log(recap.body);
    console.log(`\n─── (${recap.model}) ───\n`);
    console.log("(dry run — nothing claimed or posted. Re-run with `settlements post` to send it to your local groups.)");
    break;
  }

  default:
    console.error("usage: cli <sync|markets|register|bet|balance|bets|settle|summary|settlements> …");
    process.exit(1);
}

// The announcer may have connected the bot's Postgres state pool — close
// both pools or the process never exits. disconnect() no-ops if unused.
await state.disconnect();
await sql.end();
