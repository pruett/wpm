import { eq, inArray } from "drizzle-orm";
import { bot, state } from "../bot";
import { db, sql } from "../db";
import { events, markets, users } from "../db/schema";
import { seriesEmoji, seriesRank } from "../kalshi/series";
import { formatDollars, formatEastern, gifMessage, mention } from "./format";
import type { BettableAlert, MarketSettlement } from "./sync";
import type { PostableMarkdown } from "chat";

// GIFs are posted as their own message (see gifMessage) so Telegram renders
// them animated (same as the welcome GIFs in commands/start.ts).
const VICTORY_GIFS = [
  "https://media.giphy.com/media/gdwJdym3VuXQr5OfAc/giphy.gif", // McConaughey chest-thump (Wolf of Wall Street)
  "https://media.giphy.com/media/DfLwM9kttDFEQ/giphy.gif", // Leo toasting over fireworks (Gatsby)
  "https://media.giphy.com/media/l41lZccR1oUigYeNa/giphy.gif", // Lil Wayne & Fat Joe making it rain
  "https://media.giphy.com/media/gQdejV5BBChHi/giphy.gif", // Scrooge McDuck diving into the money vault
  "https://media.giphy.com/media/4q0WNCNZUlxNC/giphy.gif", // Tony Soprano smug cigar (The Sopranos)
  "https://media.giphy.com/media/qi8Yhj4pKcIec/giphy.gif", // Kenny Powers tossing cash (Eastbound & Down)
];

const SHAME_GIFS = [
  "https://media.giphy.com/media/McDuCJ9c5S37rkodHj/giphy.gif", // crying Michael Jordan meme
  "https://media.giphy.com/media/GNNwrch6eoXuTs2uLo/giphy.gif", // "this is fine" dog in the burning house
  "https://media.giphy.com/media/mdXSGzehQYZ5zotrz3/giphy.gif", // Dennis Reynolds meltdown (It's Always Sunny)
  "https://media.giphy.com/media/8fyn3ZRrAtuAo/giphy.gif", // Jason Bateman "I've made a huge mistake"
  "https://media.giphy.com/media/RVzU9AGit8VxSnsxUt/giphy.gif", // turning out an empty, broke wallet
  "https://media.giphy.com/media/TbLLgMdmhPbvTGraES/giphy.gif", // Homer reversing into the bushes
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
  // animates between its headline and its results. The bet lines go out as
  // markdown so the bettor @mentions render (and ping) in Telegram.
  const posts: Array<string | PostableMarkdown> = [];
  if (winnerLines.length) {
    posts.push("🏆 WINNER'S CIRCLE 🏆", gifMessage(pickRandom(VICTORY_GIFS)), { markdown: winnerLines.join("\n") });
  }
  if (loserLines.length) {
    posts.push("💀 LOSER'S CIRCLE 💀", gifMessage(pickRandom(SHAME_GIFS)), { markdown: loserLines.join("\n") });
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

/**
 * Ping every subscribed group that one or more events are about to close to
 * betting: a short headline, then one line per event (its series emoji, title,
 * and close time in Eastern) in registry order, soonest first. Returns how
 * many group threads were posted to. Each event is announced exactly once —
 * claimBettableAlerts flips the flag before these rows ever reach us.
 */
export async function announceBettableAlerts(alerts: BettableAlert[]): Promise<number> {
  if (alerts.length === 0) return 0;

  const threadIds = await groupThreadIds();
  if (threadIds.length === 0) return 0;

  // Connect just the state adapter so thread.post() has somewhere to append,
  // without starting a polling loop (same as announceSettlements). Idempotent.
  await state.connect();

  const sorted = [...alerts].sort(
    (a, b) =>
      seriesRank(a.seriesTicker) - seriesRank(b.seriesTicker) ||
      (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0),
  );

  const eventLines = sorted.map(
    (e) =>
      `${seriesEmoji(e.seriesTicker)} ${e.title} — ${e.startsAt ? formatEastern(e.startsAt) : "starting soon"}`,
  );
  const message = ["⏰ Last call — betting closes soon", "", ...eventLines].join("\n");

  let posted = 0;
  for (const threadId of threadIds) {
    // One dead group (bot kicked, chat deleted) must not block the rest.
    try {
      await bot.thread(threadId).post(message);
      posted++;
    } catch (error) {
      console.error(`bettable alert announcement failed for ${threadId}:`, error);
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

  // Collect each line with the amount that orders its circle — profit won for
  // winners, dollars lost for losers — so the biggest swing tops each section.
  const winners: { swing: number; line: string }[] = [];
  const losers: { swing: number; line: string }[] = [];
  for (const settlement of settlements) {
    for (const bet of settlement.bets) {
      const user = userById.get(bet.userId);
      const name = user ? mention(user) : "A mystery bettor";
      const info = marketInfo.get(settlement.marketTicker);
      const pick = info
        ? `${bet.side === "yes" ? "on" : "against"} ${info.outcome} (${info.title})`
        : `on ${settlement.marketTicker}`;
      if (bet.won) {
        const payout = bet.contracts * 100;
        winners.push({
          swing: payout - bet.costCents,
          line: `• ${name} ${pickRandom(VICTORY_PHRASES)} betting ${formatDollars(bet.costCents)} ${pick} and made **+${formatDollars(payout - bet.costCents)}**`,
        });
      } else {
        losers.push({
          swing: bet.costCents,
          line: `• ${name} ${pickRandom(SHAME_PHRASES)} betting ${formatDollars(bet.costCents)} ${pick}`,
        });
      }
    }
  }
  winners.sort((a, b) => b.swing - a.swing);
  losers.sort((a, b) => b.swing - a.swing);
  return { winnerLines: winners.map((w) => w.line), loserLines: losers.map((l) => l.line) };
}
