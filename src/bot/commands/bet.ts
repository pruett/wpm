import type { ActionEvent, CardElement, Message, SentMessage, Thread } from "chat";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { db } from "../../db";
import { events, markets as marketsTable } from "../../db/schema";
import { REGISTER_PROMPT, balanceCents, findUser, placeBet } from "../../utils/house";
import { telegramProfile, telegramProfileFromAction } from "../identity";
import { formatDollars } from "../../utils/format";
import type { BotCommand } from "./types";

// Action ids; the tapped event/market ticker travels in the button's value.
// Amount buttons carry `${ticker}|${shares}s` (or `|max` / `|custom`) — Telegram
// caps callback data at 64 bytes, and ticker + delimiter + amount still fits.
// All registered via bot.onAction in src/bot/index.ts.
export const PICK_EVENT_ACTION = "pick_event";
export const PICK_OUTCOME_ACTION = "pick_outcome";
export const PICK_AMOUNT_ACTION = "pick_amount";
export const BACK_TO_EVENTS_ACTION = "back_events";

// --- Menu + pick state (postgres-backed thread state, 30-day TTL) ---

// Every user gets their own /bet menu: a single message that edits itself
// as its owner navigates (event list → outcomes → amount picker → back).
// Re-running /bet replaces only your own menu, so two users browsing at
// once never reset each other. All of it lives in thread state rather than
// memory: on Vercel each command, tap, and typed reply is a separate
// invocation, so an in-memory map would lose the menu between them.

// A tapped outcome waiting on a bet amount, keyed by platform user id.
interface PendingPick {
  ticker: string;
  outcome: string;
  eventTicker: string;
  /** Ask price at pick time, for display only — placeBet re-reads the live price. */
  priceCents: number | null;
  /** Menu message to edit with prompts/results. */
  menuMessageId: string;
}

interface BetState {
  /** Menu message id per platform user id — whose menu is whose. */
  menus?: Record<string, string>;
  pendingPicks?: Record<string, PendingPick>;
}

async function getBetState(thread: Thread<unknown>): Promise<BetState | null> {
  return (await thread.state) as BetState | null;
}

async function getPendingPick(thread: Thread<unknown>, userId: string): Promise<PendingPick | null> {
  return (await getBetState(thread))?.pendingPicks?.[userId] ?? null;
}

async function setPendingPick(
  thread: Thread<unknown>,
  userId: string,
  pick: PendingPick,
): Promise<void> {
  const state = await getBetState(thread);
  await (thread as Thread<BetState>).setState({
    pendingPicks: { ...state?.pendingPicks, [userId]: pick },
  });
}

async function clearPendingPick(thread: Thread<unknown>, userId: string): Promise<void> {
  const state = await getBetState(thread);
  if (!state?.pendingPicks?.[userId]) return;
  const { [userId]: _, ...rest } = state.pendingPicks;
  await (thread as Thread<BetState>).setState({ pendingPicks: rest });
}

async function setMenu(thread: Thread<unknown>, userId: string, messageId: string): Promise<void> {
  const state = await getBetState(thread);
  await (thread as Thread<BetState>).setState({
    menus: { ...state?.menus, [userId]: messageId },
  });
}

function menuOwner(state: BetState | null, messageId: string): string | null {
  for (const [userId, id] of Object.entries(state?.menus ?? {})) {
    if (id === messageId) return userId;
  }
  return null;
}

/**
 * Rehydrate an edit/delete handle for a menu posted in an earlier
 * invocation. The SDK only needs the message id for edit/delete, so a
 * stub Message is enough.
 */
function menuHandle(thread: Thread<unknown>, messageId: string): SentMessage {
  return thread.createSentMessageFromMessage({ id: messageId } as unknown as Message);
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

// Kickoffs are stored as UTC instants; render them in US Eastern so a
// 9pm ET game doesn't show as the next day on UTC servers like Vercel.
function kickoffLabel(startsAt: Date | null): string {
  return startsAt
    ? startsAt.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "TBD";
}

// --- Card builders (views of the menu) ---

// Event list: one full-width button per row so titles don't get ellipsized.
// Only viable, bettable events: game not started, kicking off within the
// next 2 days (betting locks at kickoff, so past starts are out too).
// Sorted most urgent first — soonest kickoff at the top. The owner's name
// in the header marks whose menu this is — menus are per-user.
async function eventsCard(ownerName: string): Promise<CardElement | null> {
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
        content: `${seriesTitle(rows[0]!.seriesTicker)} — ${ownerName}, choose an event`,
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

async function outcomesCard(eventTicker: string, ownerName: string): Promise<CardElement | null> {
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
      { type: "text", content: `${ownerName}: ${title} — ${kickoffLabel(startsAt)}`, style: "bold" },
      ...outcomes.map((m) => ({
        type: "actions" as const,
        children: [
          {
            type: "button" as const,
            id: PICK_OUTCOME_ACTION,
            label: `${m.outcome} @ ${m.yesAsk ?? "—"}¢`,
            value: m.ticker,
          },
        ],
      })),
      {
        type: "actions",
        children: [
          { type: "button" as const, id: BACK_TO_EVENTS_ACTION, label: "← All events" },
        ],
      },
    ],
  };
}

// Preset share counts so most bets are a single tap. Each button shows what
// that many shares costs at the current price (100 shares at 50¢ = $50).
const PRESET_SHARES = [100, 500, 1000, 5000];

function presetLabel(shares: number, priceCents: number | null): string {
  const count = `${shares.toLocaleString("en-US")} shares`;
  return priceCents == null ? count : `${count} — ${formatDollars(shares * priceCents)}`;
}

function amountTitle(pick: PendingPick, userName: string, balance: number) {
  return {
    type: "text" as const,
    content: `${userName} (balance: ${formatDollars(balance)}): how much on ${pick.outcome}?`,
    style: "bold" as const,
  };
}

function noteLine(note?: string) {
  return note ? [{ type: "text" as const, content: note }] : [];
}

// Plain-language gloss under the amount prompt: a stake buys shares at the
// quoted price, each paying $1 on a win — so 100 shares always pays
// $100, and the price doubles as the implied odds.
function priceExplainer(pick: PendingPick) {
  if (pick.priceCents == null) return [];
  const price = pick.priceCents;
  return [
    {
      type: "text" as const,
      content:
        `${pick.outcome} @ ${price}¢ — your stake buys ${pick.outcome} shares at ` +
        `${formatDollars(price)} each; every share pays ${formatDollars(100)} if ${pick.outcome} wins.`,
    },
    {
      type: "text" as const,
      content:
        `Example: 100 shares costs ${formatDollars(price * 100)} and pays ${formatDollars(10_000)} ` +
        `on a win (≈${price}% chance).`,
    },
  ];
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
      ...priceExplainer(pick),
      ...PRESET_SHARES.map((shares) => ({
        type: "actions" as const,
        children: [amountButton(presetLabel(shares, pick.priceCents), `${shares}s`)],
      })),
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
      ...priceExplainer(pick),
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

// Telegram rejects edits that don't change anything (e.g. a double-tapped
// back button re-rendering the same view) — that's a no-op, not a failure.
function isNotModified(err: unknown): boolean {
  return String(err).includes("not modified");
}

/** Edit the tapped menu in place; falls back to posting fresh if it's gone. */
async function showView(event: ActionEvent, card: CardElement): Promise<void> {
  if (!event.thread) return;
  try {
    await menuHandle(event.thread, event.messageId).edit({ card, fallbackText: MENU_FALLBACK });
  } catch (err) {
    if (isNotModified(err)) return;
    const sent = await event.thread.post({ card, fallbackText: MENU_FALLBACK });
    await setMenu(event.thread, event.user.userId, sent.id);
  }
}

/** Edit a menu by message id (used from typed replies, not button taps). */
async function editMenu(
  thread: Thread<unknown>,
  menuMessageId: string,
  card: CardElement,
): Promise<boolean> {
  try {
    await menuHandle(thread, menuMessageId).edit({ card, fallbackText: MENU_FALLBACK });
    return true;
  } catch (err) {
    return isNotModified(err);
  }
}

/**
 * Owner gate for menu taps. Menus are per-user: only the owner navigates
 * theirs, so one user can't reset another's view mid-flow. Menus with no
 * recorded owner (posted before per-user tracking, or after a state wipe)
 * are adopted by the first tapper so old cards keep working.
 */
async function claimMenu(event: ActionEvent): Promise<boolean> {
  if (!event.thread) return false;
  const owner = menuOwner(await getBetState(event.thread), event.messageId);
  if (owner === event.user.userId) return true;
  if (owner == null) {
    await setMenu(event.thread, event.user.userId, event.messageId);
    return true;
  }
  await event.thread.post(
    `${event.user.fullName}: that menu belongs to someone else — type /bet to get your own.`,
  );
  return false;
}

// --- Command + action handlers ---

// Posts the caller's own self-navigating menu message. Menus are per-user:
// re-running /bet replaces only your previous menu, so several users can
// browse and bet at once without resetting each other's view.
export const bet: BotCommand = {
  name: "bet",
  description: "Browse events and place a bet",
  usage: "/bet",
  handler: async ({ thread, message }) => {
    const card = await eventsCard(message.author.fullName);
    if (!card) {
      await thread.post("No markets in the database yet — run a sync first.");
      return;
    }

    const userId = message.author.userId;
    const previousId = (await getBetState(thread))?.menus?.[userId];
    if (previousId) {
      await menuHandle(thread, previousId).delete().catch(() => {}); // already gone is fine
    }
    // Any pending amount prompt pointed at the old menu — drop it too.
    await clearPendingPick(thread, userId);

    const sent = await thread.post({ card, fallbackText: MENU_FALLBACK });
    await setMenu(thread, userId, sent.id);
  },
};

// Event button tapped → menu becomes that event's outcomes.
export async function handlePickEvent(event: ActionEvent): Promise<void> {
  if (!event.value) return;
  if (!(await claimMenu(event))) return;
  const card = await outcomesCard(event.value, event.user.fullName);
  if (!card) {
    await showView(event, (await eventsCard(event.user.fullName)) ?? emptyCard());
    return;
  }
  await showView(event, card);
}

// Back button tapped → menu becomes the event list again.
export async function handleBackToEvents(event: ActionEvent): Promise<void> {
  if (!(await claimMenu(event))) return;
  await showView(event, (await eventsCard(event.user.fullName)) ?? emptyCard());
}

/** Resolve a market ticker into a PendingPick, or null if unknown. */
async function loadPick(ticker: string, menuMessageId: string): Promise<PendingPick | null> {
  const [market] = await db
    .select({
      outcome: marketsTable.outcome,
      eventTicker: marketsTable.eventTicker,
      yesAsk: marketsTable.yesAsk,
    })
    .from(marketsTable)
    .where(eq(marketsTable.ticker, ticker))
    .limit(1);
  if (!market) return null;
  return {
    ticker,
    outcome: market.outcome,
    eventTicker: market.eventTicker,
    priceCents: market.yesAsk,
    menuMessageId,
  };
}

// Outcome button tapped → menu becomes the amount picker. The pick is also
// remembered so a typed amount works without tapping "Custom amount…" first.
export async function handlePickOutcome(event: ActionEvent): Promise<void> {
  const ticker = event.value;
  if (!ticker) return;
  if (!(await claimMenu(event))) return;

  const pick = await loadPick(ticker, event.messageId);
  if (!pick) {
    await showView(event, (await eventsCard(event.user.fullName)) ?? emptyCard());
    return;
  }

  // Gate before showing the amount picker — anyone can browse, only
  // registered users can bet. The menu stays put; the prompt is a
  // separate message so it reads as addressed to the tapper.
  const userId = await findUser(telegramProfileFromAction(event));
  if (userId == null) {
    await event.thread?.post(`${event.user.fullName}: ${REGISTER_PROMPT}`);
    return;
  }
  if (event.thread) await setPendingPick(event.thread, event.user.userId, pick);

  const balance = await balanceCents(userId);
  await showView(event, amountPickerCard(pick, event.user.fullName, balance));
}

// Amount button tapped → place the bet for the menu's owner, or open the
// typed "custom amount" prompt.
export async function handlePickAmount(event: ActionEvent): Promise<void> {
  const [ticker, spec] = (event.value ?? "").split("|");
  if (!ticker || !spec) return;
  if (!(await claimMenu(event))) return;

  const pick = await loadPick(ticker, event.messageId);
  if (!pick) {
    await showView(event, (await eventsCard(event.user.fullName)) ?? emptyCard());
    return;
  }

  const userName = event.user.fullName;
  const profile = telegramProfileFromAction(event);
  const userId = await findUser(profile);
  if (userId == null) {
    await event.thread?.post(`${userName}: ${REGISTER_PROMPT}`);
    return;
  }
  const balance = await balanceCents(userId);

  if (spec === "custom") {
    if (event.thread) await setPendingPick(event.thread, event.user.userId, pick);
    await showView(event, customAmountCard(pick, userName, balance));
    return;
  }

  // `${shares}s` buys exactly that many shares at the live price (placeBet
  // floors stake/price, so shares × price converts back to the same count).
  let stakeCents: number;
  if (spec === "max") {
    stakeCents = balance;
  } else if (spec.endsWith("s")) {
    const shares = Number(spec.slice(0, -1));
    stakeCents =
      Number.isInteger(shares) && pick.priceCents != null ? shares * pick.priceCents : Number.NaN;
  } else {
    stakeCents = Number(spec);
  }
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    const note =
      spec === "max"
        ? `MAX needs a positive balance.`
        : spec.endsWith("s")
          ? `No live price for ${pick.outcome} right now — try again after the next sync.`
          : `That amount didn't parse.`;
    await showView(event, amountPickerCard(pick, userName, balance, note));
    return;
  }
  if (stakeCents > balance) {
    await showView(
      event,
      amountPickerCard(pick, userName, balance, `Not enough funds — your balance is ${formatDollars(balance)}.`),
    );
    return;
  }

  try {
    const { contracts, price, cost } = await placeBet(profile, ticker, "yes", stakeCents);
    if (event.thread) await clearPendingPick(event.thread, event.user.userId);
    await showView(event, (await eventsCard(userName)) ?? emptyCard());
    await event.thread?.post(
      `✅ ${userName} bought ${contracts.toLocaleString("en-US")} ${pick.outcome} shares @ ${price}¢ for ${formatDollars(cost)} — pays ${formatDollars(contracts * 100)} if ${pick.outcome} wins`,
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
  const pick = await getPendingPick(thread, message.author.userId);
  if (!pick) return false;

  const userName = message.author.fullName;
  const text = message.text?.trim() ?? "";

  const backToEvents = async () => {
    const card = (await eventsCard(userName)) ?? emptyCard();
    if (!(await editMenu(thread, pick.menuMessageId, card))) {
      const sent = await thread.post({ card, fallbackText: MENU_FALLBACK });
      await setMenu(thread, message.author.userId, sent.id);
    }
  };

  if (/^cancel$/i.test(text)) {
    await clearPendingPick(thread, message.author.userId);
    await backToEvents();
    return true;
  }

  const profile = telegramProfile(message);
  const userId = await findUser(profile);
  if (userId == null) {
    await clearPendingPick(thread, message.author.userId);
    await thread.post(`${userName}: ${REGISTER_PROMPT}`);
    return true;
  }
  const balance = await balanceCents(userId);
  const reprompt = async (note: string) => {
    if (!(await editMenu(thread, pick.menuMessageId, customAmountCard(pick, userName, balance, note)))) {
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
    await reprompt(`Not enough funds — your balance is ${formatDollars(balance)}.`);
    return true;
  }

  try {
    const { contracts, price, cost } = await placeBet(profile, pick.ticker, "yes", stakeCents);
    await clearPendingPick(thread, message.author.userId);
    await backToEvents();
    await thread.post(
      `✅ ${userName} bought ${contracts.toLocaleString("en-US")} ${pick.outcome} shares @ ${price}¢ for ${formatDollars(cost)} — pays ${formatDollars(contracts * 100)} if ${pick.outcome} wins`,
    );
  } catch (err) {
    // Pick stays in thread state so the user can just type another amount.
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
