import type { ActionEvent, CardElement, Message, SentMessage, Thread } from "chat";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import { db } from "../../db";
import { events, markets as marketsTable } from "../../db/schema";
import { REGISTER_PROMPT, balanceCents, findUser, placeBet } from "../../utils/house";
import { telegramProfile, telegramProfileFromAction } from "../identity";
import {
  formatDecimalOdds,
  formatDollars,
  formatEastern,
  formatStakeReturn,
} from "../../utils/format";
import { seriesRank, seriesTitle } from "../../kalshi/series";
import { BETTABLE_HORIZON_MS } from "../../utils/sync";
import type { BotCommand } from "./types";

// Action ids; the tapped event/market ticker travels in the button's value.
// Telegram caps callback data at 64 bytes, and the adapter wraps each id as
// `chat:{"a":"<id>","v":"<value>"}` (~22 bytes fixed with these short ids), so
// both the id and value eat into the budget. The outcome/event buttons carry a
// full Kalshi ticker (up to ~27 chars) as their value, so short ids keep them
// clear of the cap; the amount buttons carry only the spec (the ticker lives in
// pending state — see amountPickerCard). All registered via bot.onAction in
// src/bot/index.ts.
export const PICK_EVENT_ACTION = "pe";
export const PICK_OUTCOME_ACTION = "po";
export const PICK_AMOUNT_ACTION = "pa";
export const BACK_TO_EVENTS_ACTION = "back_events";
// Series-header rows in the keyboard — a tap does nothing. Telegram renders
// all card text above the keyboard, so headers must be button rows to sit
// between event buttons.
export const NOOP_ACTION = "noop";

/** Full-width label row used as a series header inside the keyboard. */
export function seriesHeaderRow(seriesTicker: string) {
  return {
    type: "actions" as const,
    children: [
      {
        type: "button" as const,
        id: NOOP_ACTION,
        label: `— ${seriesTitle(seriesTicker)} —`,
      },
    ],
  };
}

// --- Menu + pick state (postgres-backed thread state, 30-day TTL) ---

// Every user gets their own /placebet menu: a single message that edits itself
// as its owner navigates (event list → outcomes → amount picker → back).
// Re-running /placebet replaces only your own menu, so two users browsing at
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
export function menuHandle(thread: Thread<unknown>, messageId: string): SentMessage {
  return thread.createSentMessageFromMessage({ id: messageId } as unknown as Message);
}

export function kickoffLabel(startsAt: Date | null): string {
  return startsAt ? formatEastern(startsAt) : "TBD";
}

interface UpcomingEvent {
  eventTicker: string;
  seriesTicker: string;
  title: string;
  startsAt: Date | null;
}

/**
 * Viable, bettable events for /placebet's menu: kicking off in the future but
 * within the next 2 days. Betting locks at kickoff, so a future start is
 * exactly "game not started yet" — no need to also match on gameStatus,
 * whose pre-game vocabulary varies by sport (soccer "not_started", NBA
 * "created", …) and silently hid events whenever Kalshi used a value we
 * hadn't enumerated. Sorted most urgent first — soonest kickoff at the
 * top. Only events that actually have markets in the mirror. (/showbets has
 * its own, broader query — it also lists in-play events with open bets.)
 */
async function upcomingEvents(): Promise<UpcomingEvent[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + BETTABLE_HORIZON_MS);

  return db
    .selectDistinct({
      eventTicker: events.eventTicker,
      seriesTicker: events.seriesTicker,
      title: events.title,
      startsAt: events.startsAt,
    })
    .from(marketsTable)
    .innerJoin(events, eq(events.eventTicker, marketsTable.eventTicker))
    .where(and(gt(events.startsAt, now), lte(events.startsAt, horizon)))
    .orderBy(asc(events.startsAt), asc(events.eventTicker));
}

export interface SeriesGroup<T> {
  seriesTicker: string;
  events: T[];
}

/**
 * Group events into one menu section per series, ordered the way the
 * registry lists them. Events keep their incoming order within each
 * section. Shared by the /placebet and /showbets event lists.
 */
export function groupBySeries<T extends { seriesTicker: string }>(rows: T[]): SeriesGroup<T>[] {
  const bySeries = new Map<string, T[]>();
  for (const row of rows) {
    const group = bySeries.get(row.seriesTicker);
    if (group) group.push(row);
    else bySeries.set(row.seriesTicker, [row]);
  }
  return [...bySeries.entries()]
    .map(([seriesTicker, events]) => ({ seriesTicker, events }))
    .sort((a, b) => seriesRank(a.seriesTicker) - seriesRank(b.seriesTicker));
}

// --- Card builders (views of the menu) ---

// Event list: a header per series, then one full-width button per event so
// titles don't get ellipsized. The owner's name in the top line marks whose
// menu this is — menus are per-user.
async function eventsCard(ownerName: string): Promise<CardElement | null> {
  const rows = await upcomingEvents();
  if (rows.length === 0) return null;

  return {
    type: "card",
    children: [
      {
        type: "text",
        content: `${ownerName}, select an event and place your bet`,
        style: "bold",
      },
      ...groupBySeries(rows).flatMap((group) => [
        seriesHeaderRow(group.seriesTicker),
        ...group.events.map((e) => ({
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
      ]),
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
      {
        type: "text",
        content: `**${ownerName}**, place your bet on **${title}** - *${kickoffLabel(startsAt)}*`,
      },
      ...outcomes.map((m) => {
        const back = formatStakeReturn(m.yesAsk);
        const odds = `@ ${formatDecimalOdds(m.yesAsk)}`;
        return {
          type: "actions" as const,
          children: [
            {
              type: "button" as const,
              id: PICK_OUTCOME_ACTION,
              label: back ? `${m.outcome} ${odds}  (${back})` : `${m.outcome} ${odds}`,
              value: m.ticker,
            },
          ],
        };
      }),
      {
        type: "actions",
        children: [
          { type: "button" as const, id: BACK_TO_EVENTS_ACTION, label: "← All events" },
        ],
      },
    ],
  };
}

// Preset dollar stakes so most bets are a single tap. Each button shows the
// stake and what it returns at the live price ($100 (pays $106) at 94¢).
const PRESET_AMOUNTS = [100, 250, 500, 1000, 2500];

function presetLabel(dollars: number, priceCents: number | null): string {
  return formatStakeReturn(priceCents, dollars, "pays") ?? formatDollars(dollars * 100);
}

function amountTitle(pick: PendingPick, userName: string, balance: number) {
  return {
    type: "text" as const,
    content: `**${userName}** (*balance: ${formatDollars(balance)}*): How much do you want to bet on **${pick.outcome}**?`,
  };
}

function noteLine(note?: string) {
  return note ? [{ type: "text" as const, content: note }] : [];
}

// Amount picker: tap a preset to bet it, or "Custom amount…" to type one.
// Each tap bets for the tapper. The button value carries only the amount spec
// (e.g. "20000s" / "custom") — not the ticker, which `setPendingPick` has
// already written to durable thread state. handlePickAmount recovers the
// market from that pending pick, keyed by (thread, user). Keeping the long
// Kalshi ticker out of the payload is what holds callback_data under
// Telegram's 64-byte cap regardless of ticker length (see PICK_*_ACTION note).
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
    value: spec,
  });
  return {
    type: "card",
    children: [
      ...noteLine(note),
      amountTitle(pick, userName, balance),
      ...PRESET_AMOUNTS.map((dollars) => ({
        type: "actions" as const,
        children: [amountButton(presetLabel(dollars, pick.priceCents), `${dollars * 100}`)],
      })),
      {
        type: "actions",
        children: [amountButton("Enter custom dollar amount…", "custom")],
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
      {
        type: "text",
        content: `\nReply with a dollar amount, e.g. $1000 — or "cancel".`,
        style: "bold",
      },
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

// A quiet confirmation post: who bet, the fill, and what's at stake — the
// amount in and the payout out. Shared by the tap and typed-amount paths.
function betConfirmation(
  userName: string,
  outcome: string,
  contracts: number,
  cost: number,
): string {
  const payout = contracts * 100;
  return `🎟  **${userName}** bets **${formatDollars(cost)}** on **${outcome}**. Pays **${formatDollars(payout)} (+${formatDollars(payout - cost)})** if it hits`;
}

// --- Menu rendering helpers ---

const MENU_FALLBACK = "Betting menu (buttons not supported here).";

// Telegram rejects edits that don't change anything (e.g. a double-tapped
// back button re-rendering the same view) — that's a no-op, not a failure.
export function isNotModified(err: unknown): boolean {
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
    `${event.user.fullName}: that menu belongs to someone else — type /placebet to get your own.`,
  );
  return false;
}

// --- Command + action handlers ---

// Posts the caller's own self-navigating menu message. Menus are per-user:
// re-running /placebet replaces only your previous menu, so several users can
// browse and bet at once without resetting each other's view.
export const placebet: BotCommand = {
  name: "placebet",
  description: "Browse events and place a bet",
  usage: "/placebet",
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
  const spec = event.value;
  if (!spec) return;
  if (!(await claimMenu(event))) return;

  // The ticker isn't in the payload — recover it from the pending pick that
  // handlePickOutcome wrote when it rendered this picker, then reload it for a
  // live price. A missing pick (state lapsed) falls back to the event list.
  const pending = event.thread
    ? await getPendingPick(event.thread, event.user.userId)
    : null;
  const pick = pending ? await loadPick(pending.ticker, event.messageId) : null;
  if (!pick) {
    await showView(event, (await eventsCard(event.user.fullName)) ?? emptyCard());
    return;
  }
  const ticker = pick.ticker;

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

  // Preset buttons carry the stake in cents (e.g. "10000" = $100); placeBet
  // floors stake/price into whole contracts at the live price.
  const stakeCents = Number(spec);
  if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
    await showView(event, amountPickerCard(pick, userName, balance, `That amount didn't parse.`));
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
    const { contracts, cost } = await placeBet(profile, ticker, "yes", stakeCents);
    if (event.thread) await clearPendingPick(event.thread, event.user.userId);
    await showView(event, (await eventsCard(userName)) ?? emptyCard());
    await event.thread?.post({ markdown: betConfirmation(userName, pick.outcome, contracts, cost) });
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
 * Pull a dollar amount out of a free-form reply. The first number in the
 * text wins, so "$10,000", "10000", and "10000 on USA" all read as 10000.
 * Returns the positive dollar value, or null if there's no usable number.
 */
export function parseDollarAmount(text: string): number | null {
  const match = text.match(/\$?\s*(\d[\d,]*(?:\.\d+)?)/);
  if (!match) return null;
  const dollars = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(dollars) && dollars > 0 ? dollars : null;
}

/**
 * Handle a possible reply to an amount prompt. Returns true when the message
 * was consumed (a pending pick existed for this user in this thread).
 * Prompt updates happen by editing the menu card; only the final bet
 * confirmation is posted as a message.
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

  const dollars = parseDollarAmount(text);
  if (dollars == null) {
    await reprompt(`That's not a positive dollar amount.`);
    return true;
  }
  const stakeCents = Math.round(dollars * 100);

  if (stakeCents > balance) {
    await reprompt(`Not enough funds — your balance is ${formatDollars(balance)}.`);
    return true;
  }

  try {
    const { contracts, cost } = await placeBet(profile, pick.ticker, "yes", stakeCents);
    await clearPendingPick(thread, message.author.userId);
    await backToEvents();
    await thread.post({ markdown: betConfirmation(userName, pick.outcome, contracts, cost) });
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
