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
 */
import { asc, eq } from "drizzle-orm";
import { db, sql } from "../db";
import { bets, events, markets, users } from "../db/schema";
import { balanceCents, findUser, placeBet, registerUser, settleMarketBets, type BetSide } from "./house";
import { settleOpenBetMarkets, sync, syncAll } from "./sync";
import { state } from "../bot";

const dollars = (c: number | null) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const [cmd, ...args] = Bun.argv.slice(2);

switch (cmd) {
  case "sync": {
    // No arg syncs every tracked series (what the cron does); an explicit
    // series ticker syncs just that one. Both end with the settlement pass.
    const { series, settledBets, voidedBets } = args[0]
      ? await (async () => {
          const stats = await sync(args[0]!);
          const settlement = await settleOpenBetMarkets();
          return {
            series: [stats],
            settledBets: stats.settledBets + settlement.settledBets,
            voidedBets: stats.voidedBets + settlement.voidedBets,
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

  default:
    console.error("usage: cli <sync|markets|register|bet|balance|bets|settle> …");
    process.exit(1);
}

// The announcer may have connected the bot's Postgres state pool — close
// both pools or the process never exits. disconnect() no-ops if unused.
await state.disconnect();
await sql.end();
