# wpm-2 — Telegram bot on Chat SDK

A single Bun + TypeScript app: a Telegram echo bot built on
[Chat SDK](https://chat-sdk.dev). Chat, cron, and a database will all live
here and deploy together.

## Layout

```
package.json              # one package — scripts, deps
tsconfig.json             # TS config (jsxImportSource: "chat" for JSX cards later)
src/
  bot.ts                  # Chat instance: adapter + state + event handlers
  index.ts                # entrypoint: bot.initialize() starts the polling loop
.env                      # TELEGRAM_BOT_TOKEN lives here (gitignored)
```

## How a message reaches your code (polling mode)

```
src/index.ts calls bot.initialize()
  → adapter deletes any registered webhook (polling and webhooks are
    mutually exclusive in Telegram)
  → adapter long-polls https://api.telegram.org/bot<token>/getUpdates
  → Telegram holds the request open (~30s) and responds the moment
    someone messages your bot
  → Chat SDK dedupes, normalizes the update into Thread/Message objects
  → routes to onDirectMessage / onSubscribedMessage in src/bot.ts
```

The bot dials *out* to Telegram, so nothing needs to reach your machine —
no public URL, no tunnel, no webhook registration. In production you'd flip
to webhook mode (Telegram pushes updates to your HTTPS endpoint), which is
a config change plus an HTTP route, not a rewrite.

Chat SDK normalizes Telegram updates into platform-agnostic `Thread` and
`Message` objects, so handler code is portable to Slack/Discord/etc. later by
registering more adapters.

## Local dev loop

```bash
bun run dev   # that's it — watch mode, restarts on save
```

Then DM your bot on Telegram — it echoes back.

## Group chats

The bot enters a group conversation via `onNewMention` (someone @-mentions
it), subscribes, and from then on receives the group's messages through
`onSubscribedMessage`. Two Telegram-side settings make this work:

- **BotFather → /setprivacy → Disable**: by default Telegram only delivers
  group messages that are commands, @-mentions of the bot, or replies to it.
  Disabling privacy mode delivers every group message. If the bot was already
  in a group when you toggle this, remove and re-add it for the change to
  take effect. (Making the bot a group admin also bypasses privacy mode.)
- **BotFather → /setjoingroups → Enable**: allows adding the bot to groups
  (this is the default).

## Decisions so far

- **Flat single-package repo** — started as a Bun workspaces monorepo, but
  one deployable app (chat + future cron + database together) doesn't need
  workspace overhead.
- **Polling mode for local dev** — originally webhook mode + a cloudflared
  tunnel, but the adapter's `getUpdates` polling makes the tunnel pure
  overhead locally. Webhooks return when we deploy.
- **Memory state adapter** — subscriptions/dedupe reset on restart. Swap for
  `@chat-adapter/state-redis` or `state-pg` before deploying for real.
