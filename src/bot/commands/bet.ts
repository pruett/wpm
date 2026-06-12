import type { ActionEvent, CardElement, Message, SentMessage, Thread } from "chat";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { db } from "../../db";
import { events, markets as marketsTable } from "../../db/schema";
import { REGISTER_PROMPT, balanceCents, findUser, placeBet } from "../../utils/house";
import { telegramProfile, telegramProfileFromAction } from "../identity";
import { formatCents } from "./mocks";
import type { BotCommand } from "./types";

// Action ids; the tapped event/market ticker travels in the button's value.
// Amount buttons carry `${ticker}|${cents}` (or `|max` / `|custom`) — Telegram
// caps callback data at 64 bytes, and ticker + delimiter + amount still fits.
// All registered via bot.onAction in src/bot/index.ts.
export const PICK_EVENT_ACTION = "pick_event";
export const PICK_OUTCOME_ACTION = "pick_outcome";
export const PICK_AMOUNT_ACTION = "pick_amount";
export const BACK_TO_EVENTS_ACTION = "back_events";

// --- In-place menu state (in-memory; restarts degrade to posting fresh) ---

// The /bet menu is a single message that edits itself as users navigate:
// event list → outcomes → amount picker → back to event list.
const menuByMessage = new Map<string, SentMessage>();
// Last menu per thread, so re-running /bet replaces instead of stacking.
const menuByThread = new Map<string, SentMessage>();

// A tapped outcome waiting on a bet amount, keyed by `${threadId}:${userId}`.
interface PendingPick {
  ticker: string;
  outcome: string;
  eventTicker: string;
  /** Menu message to edit with prompts/results. */
  menuMessageId: string;
}
const pendingPicks = new Map<string, PendingPick>();

function trackMenu(threadId: string, sent: SentMessage): void {
  menuByMessage.set(sent.id, sent);
  menuByThread.set(threadId, sent);
}

// Kalshi series tickers → friendly titles for the menu header.
const SERIES_TITLES: Record<string, string> = {
  KXWCGAME: "World Cup 2026 Games",
};

// Unknown series fall back to the raw ticker minus Kalshi's "KX" prefix,
// title-cased — "KXNBASERIES" → "Nbaseries" beats showing nothing.
export function seriesTitle(seriesTicker: string): string {
  const known = SERIES_TITLES[seriesTicker];
  if (known) return known;
  const stripped = seriesTicker.replace(/^KX/, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
}

function kickoffLabel(startsAt: Date | null): string {
  return startsAt
    ? startsAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "TBD";
}

// --- Card builders (views of the menu) ---

// Event list: one full-width button per row so titles don't get ellipsized.
// Only viable, bettable events: game not started, kicking off within the
// next 2 days (betting locks at kickoff, so past starts are out too).
// Sorted most urgent first — soonest kickoff at the top.
async function eventsCard(): Promise<CardElement | null> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  const rows = await db
    .selectDistinct({
      eventTicker: events.eventTicker,
      seriesTicker: events.seriesTicker,
      title: events.title,
      startsAt: events.startsAt,
    })
    .from(marketsTable)
    .innerJoin(events, eq(events.eventTicker, marketsTable.eventTicker))
    .where(
      and(
        eq(events.gameStatus, "not_started"),
        gt(events.startsAt, now),
        lte(events.startsAt, horizon),
      ),
    )
    .orderBy(asc(events.startsAt), asc(events.eventTicker));

  if (rows.length === 0) return null;

  return {
    type: "card",
    children: [
      {
        type: "text",
        content: `${seriesTitle(rows[0]!.seriesTicker)} — choose an event`,
        style: "bold",
      },
      ...rows.map((e) => ({
        type: "actions" as const,
        children: [
          {
            type: "button" as const,
            id: PICK_EVENT_ACTION,
            label: `${e.title} — ${kickoffLabel(e.startsAt)}`,
            value: e.eventTicker,
          },
        ],
      })),
    ],
  };
}

async function outcomesCard(eventTicker: string): Promise<CardElement | null> {
  const outcomes = await db
    .select({
      ticker: marketsTable.ticker,
      outcome: marketsTable.outcome,
      yesAsk: marketsTable.yesAsk,
      title: events.title,
      startsAt: events.startsAt,
    })
    .from(marketsTable)
    .innerJoin(events, eq(events.eventTicker, marketsTable.eventTicker))
    .where(eq(marketsTable.eventTicker, eventTicker))
    .orderBy(asc(marketsTable.ticker));

  if (outcomes.length === 0) return null;

  const { title, startsAt } = outcomes[0]!;
  return {
    type: "card",
    children: [
      { type: "text", content: `${title} — ${kickoffLabel(startsAt)}`, style: "bold" },
      {
        type: "actions",
        children: outcomes.map((m) => ({
          type: "button" as const,
          id: PICK_OUTCOME_ACTION,
          label: `${m.outcome} ${m.yesAsk ?? "—"}¢`,
          value: m.ticker,
        })),
      },
      {
        type: "actions",
        children: [
          { type: "button" as const, id: BACK_TO_EVENTS_ACTION, label: "← All events" },
        ],
      },
    ],
  };
}

// Preset stakes so most bets are a single tap (seed bankroll is $100,000).
const PRESET_DOLLARS = [100, 500, 1000, 5000];

function amountTitle(pick: PendingPick, userName: string, balance: number) {
  return {
    type: "text" as const,
    content: `${userName} (${formatCents(balance)}): how much on ${pick.outcome}?`,
    style: "bold" as const,
  };
}

function noteLine(note?: string) {
  return note ? [{ type: "text" as const, content: note }] : [];
}

// Amount picker: tap a preset to bet it, MAX to bet your whole balance, or
// "Custom amount…" to type one. Each tap bets for the tapper — the ticker
// rides in the button value, so taps keep working after a restart.
function amountPickerCard(
  pick: PendingPick,
  userName: string,
  balance: number,
  note?: string,
): CardElement {
  const amountButton = (label: string, spec: string) => ({
    type: "button" as const,
    id: PICK_AMOUNT_ACTION,
    label,
    value: `${pick.ticker}|${spec}`,
  });
  return {
    type: "card",
    children: [
      ...noteLine(note),
      amountTitle(pick, userName, balance),
      {
        type: "actions",
        children: PRESET_DOLLARS.map((dollars) =>
          amountButton(`$${dollars.toLocaleString("en-US")}`, String(dollars * 100)),
        ),
      },
      {
        type: "actions",
        children: [amountButton("MAX", "max"), amountButton("Custom amount…", "custom")],
      },
      {
        type: "actions",
        children: [
          {
            type: "button" as const,
            id: PICK_EVENT_ACTION,
            label: "← Outcomes",
            value: pick.eventTicker,
          },
        ],
      },
    ],
  };
}

// Typed-amount fallback behind the "Custom amount…" button.
function customAmountCard(
  pick: PendingPick,
  userName: string,
  balance: number,
  note?: string,
): CardElement {
  return {
    type: "card",
    children: [
      ...noteLine(note),
      amountTitle(pick, userName, balance),
      { type: "text", content: `Reply with a dollar amount, e.g. 50 — or "cancel".` },
      {
        type: "actions",
        children: [
          {
            type: "button" as const,
            id: PICK_OUTCOME_ACTION,
            label: "← Amounts",
            value: pick.ticker,
          },
        ],
      },
    ],
  };
}

// --- Menu rendering helpers ---

const MENU_FALLBACK = "Betting menu (buttons not supported here).";

/** Edit the menu message in place; falls back to posting fresh after a restart. */
async function showView(event: ActionEvent, card: CardElement): Promise<void> {
  const existing = menuByMessage.get(event.messageId);
  if (existing) {
    await existing.edit({ card, fallbackText: MENU_FALLBACK });
    return;
  }
  if (event.thread) {
    trackMenu(event.threadId, await event.thread.post({ card, fallbackText: MENU_FALLBACK }));
  }
}

/** Edit a menu by message id (used from message replies, not button taps). */
async function editMenu(menuMessageId: string, card: CardElement): Promise<boolean> {
  const menu = menuByMessage.get(menuMessageId);
  if (!menu) return false;
  await menu.edit({ card, fallbackText: MENU_FALLBACK });
  return true;
}

// --- Command + action handlers ---

// Posts the single self-navigating menu message. Re-running /bet
// removes the previous menu in the thread so only one exists at a time.
export const bet: BotCommand = {
  name: "bet",
  description: "Browse events and place a bet",
  usage: "/bet",
  handler: async ({ thread, message }) => {
    const card = await eventsCard();
    if (!card) {
      await thread.post("No markets in the database yet — run a sync first.");
      return;
    }

    const previous = menuByThread.get(message.threadId);
    if (previous) {
      menuByMessage.delete(previous.id);
      menuByThread.delete(message.threadId);
      await previous.delete().catch(() => {}); // already gone is fine
    }

    trackMenu(message.threadId, await thread.post({ card, fallbackText: MENU_FALLBACK }));
  },
};

// Event button tapped → menu becomes that event's outcomes.
export async function handlePickEvent(event: ActionEvent): Promise<void> {
  if (!event.value) return;
  const card = await outcomesCard(event.value);
  if (!card) {
    await showView(event, (await eventsCard()) ?? emptyCard());
    return;
  }
  await showView(event, card);
}

// Back button tapped → menu becomes the event list again.
export async function handleBackToEvents(event: ActionEvent): Promise<void> {
  await showView(event, (await eventsCard()) ?? emptyCard());
}

/** Resolve a market ticker into a PendingPick, or null if unknown. */
async function loadPick(ticker: string, menuMessageId: string): Promise<PendingPick | null> {
  const [market] = await db
    .select({ outcome: marketsTable.outcome, eventTicker: marketsTable.eventTicker })
    .from(marketsTable)
    .where(eq(marketsTable.ticker, ticker))
    .limit(1);
  if (!market) return null;
  return { ticker, outcome: market.outcome, eventTicker: market.eventTicker, menuMessageId };
}

// Outcome button tapped → menu becomes the amount picker. The pick is also
// remembered so a typed amount works without tapping "Custom amount…" first.
export async function handlePickOutcome(event: ActionEvent): Promise<void> {
  const ticker = event.value;
  if (!ticker) return;

  const pick = await loadPick(ticker, event.messageId);
  if (!pick) {
    await showView(event, (await eventsCard()) ?? emptyCard());
    return;
  }

  // Gate before showing the amount picker — anyone can browse, only
  // registered users can bet. The shared menu stays put; the prompt is
  // a separate message so it reads as addressed to the tapper.
  const userId = await findUser(telegramProfileFromAction(event));
  if (userId == null) {
    await event.thread?.post(`${event.user.fullName}: ${REGISTER_PROMPT}`);
    return;
  }
  pendingPicks.set(`${event.threadId}:${event.user.userId}`, pick);

  const balance = await balanceCents(userId);
  await showView(event, amountPickerCard(pick, event.user.fullName, balance));
}

// Amount button tapped → place the bet for the tapper, or open the typed
// "custom amount" prompt. Anyone in the group can tap; each bet is theirs.
export async function handlePickAmount(event: ActionEvent): Promise<void> {
  const [ticker, spec] = (event.value ?? "").split("|");
  if (!ticker || !spec) return;

  const pick = await loadPick(ticker, event.messageId);
  if (!pick) {
    await showView(event, (await eventsCard()) ?? emptyCard());
    return;
  }

  const key = `${event.threadId}:${event.user.userId}`;
  const userName = event.user.fullName;
  const profile = telegramProfileFromAction(event);
  const userId = await findUser(profile);
  if (userId == null) {
    await event.thread?.post(`${userName}: ${REGISTER_PROMPT}`);
    return;
  }
  const balance = await balanceCents(userId);

  if (spec === "custom") {
    pendingPicks.set(key, pick);
    await showView(event, customAmountCard(pick, userName, balance));
    return;
  }

  const stakeCents = spec === "max" ? balance : Number(spec);
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    const note = spec === "max" ? `MAX needs a positive balance.` : `That amount didn't parse.`;
    await showView(event, amountPickerCard(pick, userName, balance, note));
    return;
  }
  if (stakeCents > balance) {
    await showView(
      event,
      amountPickerCard(pick, userName, balance, `Not enough funds — your balance is ${formatCents(balance)}.`),
    );
    return;
  }

  try {
    const { contracts, price, cost } = await placeBet(profile, ticker, "yes", stakeCents);
    pendingPicks.delete(key);
    await showView(event, (await eventsCard()) ?? emptyCard());
    await event.thread?.post(
      `✅ ${userName}: ${pick.outcome} — ${contracts} @ ${price}¢ = ${formatCents(cost)}, pays ${formatCents(contracts * 100)}`,
    );
  } catch (err) {
    await showView(
      event,
      amountPickerCard(
        pick,
        userName,
        balance,
        `Couldn't place that bet: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }
}

/**
 * Handle a possible reply to an amount prompt. Returns true when the message
 * was consumed (a pending pick existed for this user in this thread).
 * Prompt updates happen by editing the menu card; only the final bet
 * confirmation is posted as a (terse) message.
 */
export async function handleBetReply(thread: Thread, message: Message): Promise<boolean> {
  const key = `${message.threadId}:${message.author.userId}`;
  const pick = pendingPicks.get(key);
  if (!pick) return false;

  const userName = message.author.fullName;
  const text = message.text?.trim() ?? "";

  const backToEvents = async () => {
    const card = (await eventsCard()) ?? emptyCard();
    if (!(await editMenu(pick.menuMessageId, card))) {
      await thread.post({ card, fallbackText: MENU_FALLBACK });
    }
  };

  if (/^cancel$/i.test(text)) {
    pendingPicks.delete(key);
    await backToEvents();
    return true;
  }

  const profile = telegramProfile(message);
  const userId = await findUser(profile);
  if (userId == null) {
    pendingPicks.delete(key);
    await thread.post(`${userName}: ${REGISTER_PROMPT}`);
    return true;
  }
  const balance = await balanceCents(userId);
  const reprompt = async (note: string) => {
    if (!(await editMenu(pick.menuMessageId, customAmountCard(pick, userName, balance, note)))) {
      await thread.post(note);
    }
  };

  const dollars = Number(text.replace(/^\$/, ""));
  if (!Number.isFinite(dollars) || dollars <= 0) {
    await reprompt(`That's not a positive dollar amount.`);
    return true;
  }
  const stakeCents = Math.round(dollars * 100);

  if (stakeCents > balance) {
    await reprompt(`Not enough funds — your balance is ${formatCents(balance)}.`);
    return true;
  }

  pendingPicks.delete(key);
  try {
    const { contracts, price, cost } = await placeBet(profile, pick.ticker, "yes", stakeCents);
    await backToEvents();
    await thread.post(
      `✅ ${userName}: ${pick.outcome} — ${contracts} @ ${price}¢ = ${formatCents(cost)}, pays ${formatCents(contracts * 100)}`,
    );
  } catch (err) {
    pendingPicks.set(key, pick);
    await reprompt(`Couldn't place that bet: ${err instanceof Error ? err.message : err}`);
  }
  return true;
}

function emptyCard(): CardElement {
  return {
    type: "card",
    children: [{ type: "text", content: "No markets available — run a sync first." }],
  };
}
