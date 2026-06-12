import { eq, inArray } from "drizzle-orm";
import { bot, state } from "../bot";
import { db, sql } from "../db";
import { events, markets, users } from "../db/schema";
import { displayName, formatDollars } from "./format";
import type { BetSide, SettledBet } from "./house";

/** Everything the sweep learned when one market's bets settled. */
export interface MarketSettlement {
  marketTicker: string;
  result: BetSide;
  bets: SettledBet[];
}

// GIFs are posted as their own message so Telegram's link preview renders
// them animated (same trick as the welcome GIFs in commands/start.ts).
const VICTORY_GIFS = [
  "https://media.giphy.com/media/LdOyjZ7io5Msw/giphy.gif", // Mr. Krabs showering in cash
  "https://media.giphy.com/media/LCdPNT81vlv3y/giphy.gif", // money snow-angel in a pile of bills
  "https://media.giphy.com/media/11sBLVxNs7v6WA/giphy.gif", // minions crowd going wild
  "https://media.giphy.com/media/JltOMwYmi0VrO/giphy.gif", // Brad Pitt victory flex
  "https://media.giphy.com/media/TdfyKrN7HGTIY/giphy.gif", // SpongeBob & Patrick cheering
];

const SHAME_GIFS = [
  "https://media.giphy.com/media/d2lcHJTG5Tscg/giphy.gif", // ugly-crying on the couch
  "https://media.giphy.com/media/kKdgdeuO2M08M/giphy.gif", // dramatic gopher turn
  "https://media.giphy.com/media/L95W4wv8nnb9K/giphy.gif", // teary-eyed Pikachu
  "https://media.giphy.com/media/ISOckXUybVfQ4/giphy.gif", // sad SpongeBob alone at the diner
];

// One is rolled per bet line: "Kevin took home the victory — bet $110 …"
const VICTORY_PHRASES = [
  "took home the victory",
  "cashed a fat ticket",
  "beat the house like a drum",
  "called it like a prophet",
  "is eating GOOD tonight",
  "just printed money",
];

const SHAME_PHRASES = [
  "shit the bed",
  "fumbled the bag",
  "made a generous donation to the house",
  "got absolutely cooked",
  "lit cash on fire",
  "never stood a chance",
];

function pickRandom(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Telegram group threads the bot has been invited into. The chat SDK's
 * Postgres state keeps one chat_state_subscriptions row per subscribed
 * thread; Telegram group chat ids are negative and DM ids positive, so the
 * "telegram:-" prefix selects exactly the groups.
 */
async function groupThreadIds(): Promise<string[]> {
  const rows = await sql<{ thread_id: string }[]>`
    SELECT DISTINCT thread_id FROM chat_state_subscriptions
    WHERE thread_id LIKE 'telegram:-%'
  `;
  return rows.map((r) => r.thread_id);
}

/**
 * Recap a sweep's settlements in every subscribed group as two sections:
 * a WINNER'S CIRCLE (headline → victory GIF → one line per winning bet) and
 * a LOSER'S CIRCLE (headline → shame GIF → one roast line per losing bet).
 * Returns how many group threads were posted to. Settlement is idempotent,
 * so each bet shows up in exactly one sweep's announcement.
 */
export async function announceSettlements(
  settlements: MarketSettlement[],
  voidedBets: number,
): Promise<number> {
  const settled = settlements.flatMap((s) => s.bets);
  if (settled.length === 0 && voidedBets === 0) return 0;

  const threadIds = await groupThreadIds();
  if (threadIds.length === 0) return 0;

  // thread.post() appends to the SDK's Telegram thread-history state, which
  // needs the state adapter connected. Webhooks get this via initialize();
  // here we connect just the state so no polling loop starts. Idempotent.
  await state.connect();

  const { winnerLines, loserLines } = await buildLines(settlements);

  // Each circle is three messages — headline, GIF, bet lines — so the GIF
  // animates between its headline and its results.
  const posts: string[] = [];
  if (winnerLines.length) {
    posts.push("🏆🥇 WINNER'S CIRCLE 🥇🏆", pickRandom(VICTORY_GIFS), winnerLines.join("\n"));
  }
  if (loserLines.length) {
    posts.push("💀🤡 LOSER'S CIRCLE 🤡💀", pickRandom(SHAME_GIFS), loserLines.join("\n"));
  }
  if (voidedBets > 0) {
    posts.push(`♻️ ${voidedBets} bet${voidedBets === 1 ? "" : "s"} voided and refunded.`);
  }

  let posted = 0;
  for (const threadId of threadIds) {
    // One dead group (bot kicked, chat deleted) must not block the rest.
    try {
      const thread = bot.thread(threadId);
      for (const post of posts) await thread.post(post);
      posted++;
    } catch (error) {
      console.error(`settlement announcement failed for ${threadId}:`, error);
    }
  }
  return posted;
}

/** One line per settled bet, pre-split into the two circles. */
async function buildLines(
  settlements: MarketSettlement[],
): Promise<{ winnerLines: string[]; loserLines: string[] }> {
  // Market → outcome/event context for the bet lines.
  const tickers = settlements.map((s) => s.marketTicker);
  const context = tickers.length
    ? await db
        .select({ ticker: markets.ticker, outcome: markets.outcome, title: events.title })
        .from(markets)
        .innerJoin(events, eq(events.eventTicker, markets.eventTicker))
        .where(inArray(markets.ticker, tickers))
    : [];
  const marketInfo = new Map(context.map((c) => [c.ticker, c]));

  const userIds = [...new Set(settlements.flatMap((s) => s.bets.map((b) => b.userId)))];
  const userRows = userIds.length
    ? await db.select().from(users).where(inArray(users.id, userIds))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const winnerLines: string[] = [];
  const loserLines: string[] = [];
  for (const settlement of settlements) {
    for (const bet of settlement.bets) {
      const user = userById.get(bet.userId);
      const name = user ? displayName(user) : "A mystery bettor";
      const info = marketInfo.get(settlement.marketTicker);
      const pick = info
        ? `${bet.side === "yes" ? "on" : "against"} ${info.outcome} (${info.title})`
        : `on ${settlement.marketTicker}`;
      if (bet.won) {
        const payout = bet.contracts * 100;
        winnerLines.push(
          `• ${name} ${pickRandom(VICTORY_PHRASES)} — bet ${formatDollars(bet.costCents)} ${pick} → paid ${formatDollars(payout)} (+${formatDollars(payout - bet.costCents)})`,
        );
      } else {
        loserLines.push(
          `• ${name} ${pickRandom(SHAME_PHRASES)} — bet ${formatDollars(bet.costCents)} ${pick} → up in smoke 💨`,
        );
      }
    }
  }
  return { winnerLines, loserLines };
}
