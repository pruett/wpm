import { generateText } from "ai";
import { and, gte, inArray, lt, eq } from "drizzle-orm";
import { db } from "../db";
import { bets, events, markets, recaps, users } from "../db/schema";
import { displayName, formatDollars } from "./format";
import { personaPromptBlock } from "./persona";
import type { BetSide } from "./house";

type User = typeof users.$inferSelect;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Cheap model is plenty for a chatty recap. Routed through the Vercel AI
// Gateway (OIDC in prod, AI_GATEWAY_API_KEY locally), so no provider SDK or
// per-provider key is needed — swap models by changing this env var alone.
const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? "anthropic/claude-haiku-4.5";

/** One bettor's week, folded from the bets they placed and the ones that settled. */
export interface WeeklyPlayer {
  user: User;
  /** Net realized profit/loss (cents) from bets that *settled* this week. */
  realizedCents: number;
  wins: number;
  losses: number;
  voids: number;
  /** Bets *placed* this week (volume), regardless of whether they've settled. */
  betsPlaced: number;
  stakedCents: number;
}

/** A single standout bet, used for the "biggest win / biggest loss" callouts. */
export interface BetHighlight {
  user: User;
  outcome: string;
  title: string;
  side: BetSide;
  costCents: number;
  /** Profit for a win (positive), loss for a loss (negative). */
  profitCents: number;
}

export interface WeeklyStats {
  since: Date;
  until: Date;
  betsPlaced: number;
  totalStakedCents: number;
  betsSettled: number;
  wins: number;
  losses: number;
  voids: number;
  uniqueBettors: number;
  /** Players sorted by realized P&L, biggest winner first. */
  players: WeeklyPlayer[];
  biggestWin?: BetHighlight;
  biggestLoss?: BetHighlight;
}

/**
 * Tally the past seven days of betting straight from the books. A rolling
 * window off the invocation time (not a calendar week) keeps the numbers right
 * even when the cron's UTC fire time drifts an hour across DST. Realized P&L is
 * the same per-bet math the settlement announcer uses: a winner nets
 * contracts×100 − stake, a loser nets −stake, a void nets nothing (refunded).
 */
export async function collectWeeklyStats(until = new Date()): Promise<WeeklyStats> {
  const since = new Date(until.getTime() - WEEK_MS);

  // Bets placed this week — the volume side of the recap.
  const placed = await db
    .select({ userId: bets.userId, costCents: bets.costCents })
    .from(bets)
    .where(and(gte(bets.createdAt, since), lt(bets.createdAt, until)));

  // Bets settled this week — the P&L side, with market/event context for callouts.
  const settled = await db
    .select({
      userId: bets.userId,
      side: bets.side,
      contracts: bets.contracts,
      costCents: bets.costCents,
      status: bets.status,
      outcome: markets.outcome,
      title: events.title,
    })
    .from(bets)
    .innerJoin(markets, eq(markets.ticker, bets.marketTicker))
    .innerJoin(events, eq(events.eventTicker, markets.eventTicker))
    .where(
      and(
        gte(bets.settledAt, since),
        lt(bets.settledAt, until),
        inArray(bets.status, ["won", "lost", "voided"]),
      ),
    );

  // Hydrate every bettor that shows up in either set (a bet placed last week can
  // settle this week, so the two id sets don't fully overlap).
  const userIds = [...new Set([...placed, ...settled].map((b) => b.userId))];
  const userRows = userIds.length
    ? await db.select().from(users).where(inArray(users.id, userIds))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));

  const tally = new Map<number, WeeklyPlayer>();
  const player = (userId: number): WeeklyPlayer => {
    let p = tally.get(userId);
    if (!p) {
      p = {
        user: userById.get(userId)!,
        realizedCents: 0,
        wins: 0,
        losses: 0,
        voids: 0,
        betsPlaced: 0,
        stakedCents: 0,
      };
      tally.set(userId, p);
    }
    return p;
  };

  let totalStakedCents = 0;
  for (const b of placed) {
    const p = player(b.userId);
    p.betsPlaced++;
    p.stakedCents += b.costCents;
    totalStakedCents += b.costCents;
  }

  let wins = 0;
  let losses = 0;
  let voids = 0;
  let biggestWin: BetHighlight | undefined;
  let biggestLoss: BetHighlight | undefined;
  for (const b of settled) {
    const p = player(b.userId);
    if (b.status === "won") {
      const profit = b.contracts * 100 - b.costCents;
      p.realizedCents += profit;
      p.wins++;
      wins++;
      if (!biggestWin || profit > biggestWin.profitCents) {
        biggestWin = {
          user: p.user,
          outcome: b.outcome,
          title: b.title,
          side: b.side,
          costCents: b.costCents,
          profitCents: profit,
        };
      }
    } else if (b.status === "lost") {
      p.realizedCents -= b.costCents;
      p.losses++;
      losses++;
      if (!biggestLoss || b.costCents > -biggestLoss.profitCents) {
        biggestLoss = {
          user: p.user,
          outcome: b.outcome,
          title: b.title,
          side: b.side,
          costCents: b.costCents,
          profitCents: -b.costCents,
        };
      }
    } else {
      p.voids++;
      voids++;
    }
  }

  const players = [...tally.values()].sort((a, b) => b.realizedCents - a.realizedCents);

  return {
    since,
    until,
    betsPlaced: placed.length,
    totalStakedCents,
    betsSettled: settled.length,
    wins,
    losses,
    voids,
    uniqueBettors: userIds.length,
    players,
    biggestWin,
    biggestLoss,
  };
}

/** True when the week had any betting at all — gate to avoid spamming a dead group. */
export function hadActivity(stats: WeeklyStats): boolean {
  return stats.betsPlaced > 0 || stats.betsSettled > 0;
}

const RECAP_SYSTEM = [
  "You are the resident hype-man and trash-talk commissioner for a group of friends",
  "who bet fake money against a prediction market through a Telegram bot.",
  "Write \"The Sunday Rundown\" — a short recap of the week for their group chat.",
  "",
  "Tone: fun, playful, light-hearted — like joking around with good friends. Hype the winners,",
  "and give the losers a good-natured ribbing for the bets that didn't pan out. Keep it cheeky",
  "and keep the energy up, but never mean-spirited or personal — all in good fun.",
  "",
  "Rules:",
  "- Use ONLY the names, records, and dollar figures provided. Never invent players, bets, or numbers.",
  "- Copy dollar amounts EXACTLY as written (e.g. \"$1,250\"). Do not recompute or round them.",
  "- Refer to players by the exact display names given, spelled exactly.",
  "- 120 words max. Open with a punchy line, then call out the standouts.",
  "- A little Telegram markdown (**bold**) and a few emoji, used sparingly.",
  "- No title or header, no sign-off — just the recap.",
].join("\n");

/** The hard facts handed to the model, pre-formatted so it only ever copies strings. */
function recapFacts(stats: WeeklyStats): string {
  const lines: string[] = [];
  lines.push(
    `This week: ${stats.betsPlaced} bets placed (${formatDollars(stats.totalStakedCents)} wagered), ` +
      `${stats.betsSettled} settled — ${stats.wins} won, ${stats.losses} lost` +
      `${stats.voids ? `, ${stats.voids} voided` : ""}.`,
  );
  lines.push("");
  lines.push("Players (net = profit/loss from bets that settled this week):");
  for (const p of stats.players) {
    const net = p.realizedCents;
    const netStr = `${net > 0 ? "+" : net < 0 ? "-" : ""}${formatDollars(Math.abs(net))}`;
    const record = `${p.wins}W-${p.losses}L${p.voids ? `-${p.voids}V` : ""}`;
    lines.push(
      `- ${displayName(p.user)}: net ${netStr} (${record}; placed ${p.betsPlaced} ` +
        `bet${p.betsPlaced === 1 ? "" : "s"} worth ${formatDollars(p.stakedCents)})`,
    );
  }
  if (stats.biggestWin) {
    const w = stats.biggestWin;
    lines.push("");
    lines.push(
      `Biggest win: ${displayName(w.user)} made +${formatDollars(w.profitCents)} betting ` +
        `${w.side === "yes" ? "on" : "against"} ${w.outcome} (${w.title}).`,
    );
  }
  if (stats.biggestLoss) {
    const l = stats.biggestLoss;
    lines.push(
      `Biggest loss: ${displayName(l.user)} dropped ${formatDollars(l.costCents)} betting ` +
        `${l.side === "yes" ? "on" : "against"} ${l.outcome} (${l.title}).`,
    );
  }
  return lines.join("\n");
}

/** A generated recap plus how it was produced — what gets persisted. */
export interface WeeklyRecap {
  /** Telegram-flavored markdown with bare display names (no mentions linked). */
  body: string;
  /** The Gateway model id that wrote it, or "fallback" for the safety net. */
  model: string;
}

/**
 * Ask the model to narrate the week. Numbers come pre-computed and pre-formatted
 * in the prompt, so the model only writes prose around them. Falls back to a
 * deterministic recap if the model call fails (e.g. no gateway credentials) so
 * the cron always has something to post.
 */
export async function generateWeeklyRecap(stats: WeeklyStats): Promise<WeeklyRecap> {
  const facts = recapFacts(stats);
  // Persona personalization is intentionally OFF for now — we want the recap to stay
  // light-hearted and not too personal. The wiring is kept so we can re-enable persona
  // flavor later by flipping this flag (and persona notes already live on the user rows).
  const INCLUDE_PERSONAS = false;
  // Optional, name-keyed persona flavor; empty when disabled or no player this week has notes.
  const personas = INCLUDE_PERSONAS ? personaPromptBlock(stats.players.map((p) => p.user)) : "";
  const prompt = personas
    ? `Here are this week's facts:\n\n${facts}\n\n${personas}\n\nWrite the recap.`
    : `Here are this week's facts:\n\n${facts}\n\nWrite the recap.`;
  try {
    const { text } = await generateText({
      model: SUMMARY_MODEL,
      system: RECAP_SYSTEM,
      prompt,
      temperature: 0.8,
      maxOutputTokens: 500,
    });
    const trimmed = text.trim();
    if (trimmed) return { body: trimmed, model: SUMMARY_MODEL };
    throw new Error("model returned an empty completion");
  } catch (error) {
    console.error("weekly recap generation failed, using fallback:", error);
    return { body: fallbackRecap(stats), model: "fallback" };
  }
}

/**
 * Persist a generated recap before it's posted. Stored with bare names and the
 * full stats snapshot so it can be re-rendered for any surface (Telegram or the
 * web) without losing the numbers or the ability to re-link mentions. Returns
 * the new row's id.
 */
export async function saveRecap(stats: WeeklyStats, recap: WeeklyRecap): Promise<number> {
  const [row] = await db
    .insert(recaps)
    .values({
      periodStart: stats.since,
      periodEnd: stats.until,
      body: recap.body,
      stats,
      model: recap.model,
    })
    .returning({ id: recaps.id });
  return row!.id;
}

/** Plain, no-LLM recap — the safety net when the model call can't be made. */
function fallbackRecap(stats: WeeklyStats): string {
  const top = stats.players[0];
  const bottom = stats.players[stats.players.length - 1];
  const lines = [
    `📊 **This week's tape:** ${stats.betsPlaced} bets placed, ${formatDollars(stats.totalStakedCents)} ` +
      `on the line, ${stats.wins} winners and ${stats.losses} losers.`,
  ];
  if (top && top.realizedCents > 0) {
    lines.push(`👑 ${displayName(top.user)} ran it up **+${formatDollars(top.realizedCents)}**. Drinks are on them.`);
  }
  if (bottom && bottom.realizedCents < 0 && bottom !== top) {
    lines.push(`💀 ${displayName(bottom.user)} donated **${formatDollars(-bottom.realizedCents)}** to the house. Brutal.`);
  }
  return lines.join("\n\n");
}
