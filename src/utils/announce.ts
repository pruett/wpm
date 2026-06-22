import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { eq, inArray } from "drizzle-orm";
import { bot, state } from "../bot";
import { db, sql } from "../db";
import { events, markets, users } from "../db/schema";
import { seriesEmoji, seriesRank } from "../kalshi/series";
import { displayName, formatDollars, formatEastern, gifMessage, linkMentions } from "./format";
import { personaPromptBlock } from "./persona";
import type { BettableAlert, MarketSettlement } from "./sync";
import type { PostableMarkdown } from "chat";

type User = typeof users.$inferSelect;

// Cheap model is plenty for a chatty settlement roast. Calls Anthropic directly
// via the @ai-sdk/anthropic provider (ANTHROPIC_API_KEY), same as the weekly
// recap — no Vercel AI Gateway in the path. See utils/summary.ts.
const SETTLEMENT_MODEL = process.env.SETTLEMENT_MODEL ?? "claude-haiku-4-5";

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
 * Telegram group threads to broadcast to — one per group chat. The chat SDK's
 * Postgres state keeps one chat_state_subscriptions row per subscribed thread;
 * Telegram group chat ids are negative and DM ids positive, so the "telegram:-"
 * prefix selects exactly the groups.
 *
 * A forum supergroup can end up subscribed under BOTH its bare chat thread
 * ("telegram:<chatId>") and one or more topic threads ("telegram:<chatId>:<topicId>")
 * — e.g. the bot was @-mentioned in General and again inside a topic. Those rows
 * are the SAME chat, so posting an announcement to each delivers it to the group
 * more than once (the double-post bug). We collapse every subscription to its
 * bare chat thread and dedupe, so a broadcast lands exactly once per group, in
 * its General topic. Topic subscriptions still drive command replies (which post
 * back to the incoming thread) — only the fan-out broadcast is normalized here.
 */
async function groupThreadIds(): Promise<string[]> {
  const rows = await sql<{ thread_id: string }[]>`
    SELECT DISTINCT thread_id FROM chat_state_subscriptions
    WHERE thread_id LIKE 'telegram:-%'
  `;
  // thread_id is "telegram:<chatId>" or "telegram:<chatId>:<topicId>"; the
  // chatId itself never contains a colon, so the first two segments are the
  // bare chat thread. A Set dedupes groups subscribed under multiple topics.
  const chatThreads = new Set(
    rows.map((r) => {
      const [prefix, chatId] = r.thread_id.split(":");
      return `${prefix}:${chatId}`;
    }),
  );
  return [...chatThreads];
}

/**
 * Recap a sweep's settlements in every subscribed group: a headline, one GIF
 * (victory if the batch netted out ahead, shame if it bled), then a single
 * LLM-written block of trash talk hyping the winners and roasting the losers.
 * The model only ever copies the pre-computed names and dollar figures; if the
 * call fails, a deterministic winner/loser recap goes out instead, so a group
 * always gets the news. Returns how many group threads were posted to.
 * Settlement is idempotent, so each bet shows up in exactly one announcement.
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

  const { body: rawBody, users, net } = await buildSettlementRecap(settlements, voidedBets);

  // The model writes prose with bare display names; linkMentions turns those
  // into tg:// mentions so the bettors it calls out actually get pinged.
  const body = linkMentions(rawBody, users);

  // One GIF for the whole batch, chosen by the net swing: the room's up or down.
  const gif = net >= 0 ? pickRandom(VICTORY_GIFS) : pickRandom(SHAME_GIFS);

  // Three messages — headline, GIF, recap — so the GIF animates between the
  // headline and the trash talk. The recap goes out as markdown so the @mentions
  // render (and ping) in Telegram.
  const posts: Array<string | PostableMarkdown> = [
    "💸 THE TAB IS IN 💸",
    gifMessage(gif),
    { markdown: body },
  ];

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

/**
 * Post the weekly recap to every subscribed group: a headline, a celebratory
 * GIF, then the (already mention-linked) recap markdown. The recap text is
 * built upstream — here we just frame it and fan it out, skipping any one dead
 * group without blocking the rest. Returns how many threads were posted to.
 */
export async function announceWeeklyRecap(recapMarkdown: string): Promise<number> {
  const threadIds = await groupThreadIds();
  if (threadIds.length === 0) return 0;

  await state.connect();

  const posts: Array<string | PostableMarkdown> = [
    "🧾 THE SUNDAY RUNDOWN 🧾",
    gifMessage(pickRandom(VICTORY_GIFS)),
    { markdown: recapMarkdown },
  ];

  let posted = 0;
  for (const threadId of threadIds) {
    try {
      const thread = bot.thread(threadId);
      for (const post of posts) await thread.post(post);
      posted++;
    } catch (error) {
      console.error(`weekly recap announcement failed for ${threadId}:`, error);
    }
  }
  return posted;
}

/** One settled bet, reduced to the bare facts both the prompt and the fallback need. */
interface SettledLine {
  /** Bare display name (no mention link yet) — linkMentions handles that later. */
  name: string;
  /** "on Lakers (Lakers @ Celtics)" / "against Over 220.5 (…)". */
  pick: string;
  /** Stake in cents. */
  stake: number;
  /** Profit in cents for a winner; 0 for a loser. */
  payoutNet: number;
  /** The amount that orders each section — profit won, or dollars lost. */
  swing: number;
}

/** A generated settlement recap plus everything the caller needs to frame and post it. */
export interface SettlementRecap {
  /** Trash talk with bare display names (no mentions linked yet). */
  body: string;
  /** The Gateway model id that wrote it, or "fallback" for the safety net. */
  model: string;
  /** The pre-formatted facts block fed to the model (handy for dry-run inspection). */
  facts: string;
  /** The bettors named in this batch — pass to linkMentions to ping them. */
  users: User[];
  /** Net swing across the batch (profit won − dollars lost), in cents; picks the GIF. */
  net: number;
}

/**
 * Hydrate, fact-build, and narrate a settlement batch in one call — the whole
 * generation half of announceSettlements, minus the posting. Exposed so the CLI
 * can rehearse the recap (against peeked, unclaimed data) without touching
 * Telegram, and so the announcer has a single source of truth.
 */
export async function buildSettlementRecap(
  settlements: MarketSettlement[],
  voidedBets: number,
): Promise<SettlementRecap> {
  const { marketInfo, userById } = await loadSettlementContext(settlements);
  const { winners, losers } = describeSettledBets(settlements, marketInfo, userById);
  const { body, model, facts } = await generateSettlementRecap(
    winners,
    losers,
    voidedBets,
    [...userById.values()],
  );
  const net =
    winners.reduce((n, w) => n + w.swing, 0) - losers.reduce((n, l) => n + l.swing, 0);
  return { body, model, facts, users: [...userById.values()], net };
}

/** Market outcome/event context plus the bettors, hydrated once per announcement. */
async function loadSettlementContext(settlements: MarketSettlement[]): Promise<{
  marketInfo: Map<string, { ticker: string; outcome: string; title: string }>;
  userById: Map<number, User>;
}> {
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

  return { marketInfo, userById };
}

/**
 * Flatten the settlements into bare-fact winner/loser lists, each ordered by
 * the biggest swing first so the standout bet leads its group. The same shape
 * feeds both the LLM facts block and the deterministic fallback.
 */
function describeSettledBets(
  settlements: MarketSettlement[],
  marketInfo: Map<string, { ticker: string; outcome: string; title: string }>,
  userById: Map<number, User>,
): { winners: SettledLine[]; losers: SettledLine[] } {
  const winners: SettledLine[] = [];
  const losers: SettledLine[] = [];
  for (const settlement of settlements) {
    for (const bet of settlement.bets) {
      const user = userById.get(bet.userId);
      const name = user ? displayName(user) : "A mystery bettor";
      const info = marketInfo.get(settlement.marketTicker);
      const pick = info
        ? `${bet.side === "yes" ? "on" : "against"} ${info.outcome} (${info.title})`
        : `on ${settlement.marketTicker}`;
      if (bet.won) {
        const payoutNet = bet.contracts * 100 - bet.costCents;
        winners.push({ name, pick, stake: bet.costCents, payoutNet, swing: payoutNet });
      } else {
        losers.push({ name, pick, stake: bet.costCents, payoutNet: 0, swing: bet.costCents });
      }
    }
  }
  winners.sort((a, b) => b.swing - a.swing);
  losers.sort((a, b) => b.swing - a.swing);
  return { winners, losers };
}

const SETTLEMENT_SYSTEM = [
  "You are the resident hype-man and trash-talk commissioner for a group of friends who bet",
  "fake money against a prediction market through a Telegram bot. Bets just settled and it's",
  "your job to break the news to the group chat.",
  "",
  "Tone: fun, playful, light-hearted — like joking around with good friends. Hype the winners,",
  "and give the losers a good-natured ribbing for the bets that didn't pan out. Keep it cheeky",
  "and keep the energy up, but never mean-spirited or personal — all in good fun.",
  "",
  "Rules:",
  "- Use ONLY the names, picks, and dollar figures provided. Never invent players, bets, or numbers.",
  '- Copy dollar amounts EXACTLY as written (e.g. "+$90", "$50"). Do not recompute or round them.',
  "- Refer to players by the exact display names given, spelled exactly.",
  "- Write ONE flowing block of trash talk — not a list. Roughly a sentence per notable bet.",
  "- 150 words max. Open with a punchy line, then go bet by bet.",
  "- A little Telegram markdown (**bold** the names and dollar swings) and a few emoji, used sparingly.",
  "- No title or header, no sign-off — just the trash talk.",
].join("\n");

/** The hard facts handed to the model, pre-formatted so it only ever copies strings. */
function settlementFacts(
  winners: SettledLine[],
  losers: SettledLine[],
  voidedBets: number,
): string {
  const lines: string[] = ["Bets just settled. Here's the damage:"];
  if (winners.length) {
    lines.push("", "Winners:");
    for (const w of winners) {
      lines.push(
        `- ${w.name} bet ${formatDollars(w.stake)} ${w.pick} and WON, netting +${formatDollars(w.payoutNet)}.`,
      );
    }
  }
  if (losers.length) {
    lines.push("", "Losers:");
    for (const l of losers) {
      lines.push(
        `- ${l.name} bet ${formatDollars(l.stake)} ${l.pick} and LOST the whole ${formatDollars(l.stake)}.`,
      );
    }
  }
  if (voidedBets > 0) {
    lines.push(
      "",
      `${voidedBets} bet${voidedBets === 1 ? "" : "s"} got voided and refunded — no winner, no loser.`,
    );
  }
  return lines.join("\n");
}

/**
 * Ask the model to narrate the settlement in the group's voice. Numbers come
 * pre-computed and pre-formatted in the prompt, so the model only writes prose
 * around them. Falls back to the deterministic winner/loser recap if the call
 * fails (e.g. no gateway credentials), so a settlement always has something to
 * post. Returns the body with bare display names — linkMentions runs after.
 */
async function generateSettlementRecap(
  winners: SettledLine[],
  losers: SettledLine[],
  voidedBets: number,
  users: User[],
): Promise<{ body: string; model: string; facts: string }> {
  const facts = settlementFacts(winners, losers, voidedBets);
  // Persona personalization is intentionally OFF for now — we want the roasts to stay
  // light-hearted and not too personal. The wiring is kept so we can re-enable persona
  // flavor later by flipping this flag (and persona notes already live on the user rows).
  const INCLUDE_PERSONAS = false;
  // Optional, name-keyed persona flavor; empty when disabled or no involved bettor has notes.
  const personas = INCLUDE_PERSONAS ? personaPromptBlock(users) : "";
  const prompt = personas
    ? `Here's what just settled:\n\n${facts}\n\n${personas}\n\nBreak the news.`
    : `Here's what just settled:\n\n${facts}\n\nBreak the news.`;
  try {
    const { text } = await generateText({
      model: anthropic(SETTLEMENT_MODEL),
      system: SETTLEMENT_SYSTEM,
      prompt,
      temperature: 0.9,
      maxOutputTokens: 400,
    });
    const trimmed = text.trim();
    if (trimmed) return { body: trimmed, model: SETTLEMENT_MODEL, facts };
    throw new Error("model returned an empty completion");
  } catch (error) {
    console.error("settlement recap generation failed, using fallback:", error);
    return { body: fallbackSettlementRecap(winners, losers, voidedBets), model: "fallback", facts };
  }
}

/**
 * Plain, no-LLM settlement recap — the safety net when the model call can't be
 * made. Keeps the original winner/loser flavor (the random phrase pools) as a
 * single markdown block with bare names, so linkMentions still links them.
 */
function fallbackSettlementRecap(
  winners: SettledLine[],
  losers: SettledLine[],
  voidedBets: number,
): string {
  const blocks: string[] = [];
  if (winners.length) {
    const lines = winners.map(
      (w) =>
        `• ${w.name} ${pickRandom(VICTORY_PHRASES)} betting ${formatDollars(w.stake)} ${w.pick} and made **+${formatDollars(w.payoutNet)}**`,
    );
    blocks.push(["🏆 **Winner's circle:**", ...lines].join("\n"));
  }
  if (losers.length) {
    const lines = losers.map(
      (l) => `• ${l.name} ${pickRandom(SHAME_PHRASES)} betting ${formatDollars(l.stake)} ${l.pick}`,
    );
    blocks.push(["💀 **Loser's circle:**", ...lines].join("\n"));
  }
  if (voidedBets > 0) {
    blocks.push(`♻️ ${voidedBets} bet${voidedBets === 1 ? "" : "s"} voided and refunded.`);
  }
  return blocks.join("\n\n");
}
