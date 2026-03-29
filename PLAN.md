# Auth Plan: better-auth with Magic Link + Passkey

## Context

Replace the current "enter name, get token" auth with real authentication using better-auth. Magic links for signup/recovery, passkeys for fast returning logins. better-auth runs inside SvelteKit (adapter-node) and handles identity. The Effect.ts API stays unchanged — it still validates Bearer tokens for trading routes. SvelteKit proxies all authenticated API calls, attaching the Bearer token server-side. The browser only ever has a better-auth session cookie — no localStorage tokens.

## Architecture

```
Browser (cookie-only auth)
  ├── /api/auth/*     →  SvelteKit (better-auth: sessions, magic links, passkeys)
  ├── /api/markets    →  Effect.ts API (public, no auth)
  ├── /api/bet        ─┐
  ├── /api/sell        │ SvelteKit proxy (validates session cookie,
  ├── /api/balance     │ attaches Bearer token, forwards to Effect API)
  ├── /api/positions  ─┘
  ├── /events/*       →  Effect.ts API (SSE, public)
  └── /*              →  SvelteKit (pages)
```

**Identity lives in better-auth (SQLite).** Wallet data (RSA keypair, address, Bearer token) lives in `users.json` in the Effect API for now — this is temporary tech debt. The long-term path is consolidating wallet data into SQLite and reducing the Effect API to a pure blockchain service with no user concept.

---

## Phase 1: SvelteKit → adapter-node

### 1.1 Switch adapter

- `packages/web/package.json` — replace `@sveltejs/adapter-static` with `@sveltejs/adapter-node`
- `packages/web/svelte.config.js` — swap adapter import

### 1.2 Update Dockerfile (`packages/web/Dockerfile`)

Currently builds static files and serves with nginx:alpine. Change to:

- Build stage: same (bun install, turbo build)
- Runtime: `node:22-alpine` running the SvelteKit node server
- Expose port 4102 (follows existing 4xxx convention: node=4100, api=4101, web=4102)

### 1.3 Update `docker-compose.yml`

- `wpm-web` now runs a Node process, internal port 4102
- Add env vars: `PORT=4102`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `RESEND_API_KEY`, `RP_ID`, `ORIGIN`
- Add volume for SQLite persistence (`./data/auth.db`)

### 1.4 Update `nginx/nginx.conf`

Route auth and proxied trading endpoints to SvelteKit:

```
location /api/auth/     { proxy_pass http://wpm-web:4102; }
location /api/bet       { proxy_pass http://wpm-web:4102; }
location /api/sell      { proxy_pass http://wpm-web:4102; }
location /api/balance   { proxy_pass http://wpm-web:4102; }
location /api/positions { proxy_pass http://wpm-web:4102; }
location /api/          { proxy_pass http://wpm-api:4101; }  # public: markets, health, register
location /events/       { proxy_pass http://wpm-api:4101; }  # SSE
location /              { proxy_pass http://wpm-web:4102; }  # pages
```

---

## Phase 2: better-auth Setup

### 2.1 Install dependencies (`packages/web/package.json`)

```
better-auth
@better-auth/passkey
better-sqlite3
resend
```

### 2.2 Create `packages/web/src/lib/auth.ts` (server-side)

```ts
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import Database from "better-sqlite3";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const auth = betterAuth({
  database: new Database("./data/auth.db"),
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url, metadata }) => {
        // Validate invite code (for new users) before sending
        await resend.emails.send({
          from: "WPM <noreply@yourdomain.com>",
          to: email,
          subject: "Your WPM login link",
          html: `<a href="${url}">Click to sign in</a>`,
        });
      },
    }),
    passkey({
      rpID: process.env.RP_ID || "localhost",
      rpName: "WPM",
      origin: process.env.ORIGIN || "http://localhost:5173",
    }),
  ],
});
```

### 2.3 Create `packages/web/src/hooks.server.ts`

```ts
import { auth } from "$lib/auth";
import { svelteKitHandler } from "better-auth/svelte-kit";

export async function handle({ event, resolve }) {
  // Populate session on event.locals for server-side access
  const session = await auth.api.getSession({
    headers: event.request.headers,
  });
  if (session) {
    event.locals.session = session.session;
    event.locals.user = session.user;
  }
  return svelteKitHandler({ event, resolve, auth });
}
```

### 2.4 Create `packages/web/src/lib/auth-client.ts` (client-side)

```ts
import { createAuthClient } from "better-auth/svelte";
import { magicLinkClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), passkeyClient()],
});
```

### 2.5 Run migrations

`npx auth@latest migrate` — creates `user`, `session`, `account`, `verification`, `passkey` tables in SQLite.

---

## Phase 3: Invite Codes

Stored in the same SQLite database as better-auth — one persistence layer, no separate JSON file.

### 3.1 Create `invite_code` table

Add alongside better-auth migrations (or via a startup `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE invite_code (
  code       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,       -- email or "system"
  used_by    TEXT,                -- email of consumer
  used_at    TEXT,                -- ISO timestamp
  created_at TEXT NOT NULL        -- ISO timestamp
);
```

### 3.2 Create `packages/web/src/lib/server/invite-store.ts`

- Uses the same `better-sqlite3` Database instance from `$lib/auth`
- `validate(code)`, `consume(code, email)`, `create(createdBy)`
- Validated in the `sendMagicLink` callback — if new user and no valid invite code in metadata, reject

### 3.3 Seed initial codes

Script or startup logic to insert seed invite codes if the table is empty.

---

## Phase 4: Wallet Bridge + API Proxy

SvelteKit proxies all authenticated API calls. The browser never sends a Bearer token — SvelteKit attaches it server-side after validating the session cookie.

### 4.1 Make `/api/register` idempotent (`packages/api/src/router.ts`)

Change `POST /api/register` to accept `{ name, email }`:

- If email already exists → return existing user's `{ token, address }` (no duplicate airdrop)
- If new email → create wallet, distribute airdrop, return `{ token, address, balance }`

### 4.2 Add `getByEmail` to UserStore (`packages/api/src/user-store.ts`)

- Add `email` field to `StoredUser`
- Add `emailIndex: Map<string, string>` (email → userId)
- Add `getByEmail(email)` method
- Update `register()` to accept and store email

### 4.3 Wallet creation on first login

In `hooks.server.ts` or a server layout load: after better-auth confirms a session, call the Effect API's `/api/register` with the user's name + email. Store the returned Bearer token + address in better-auth's session or a server-side mapping. This is idempotent — safe to call on every login.

### 4.4 Create SvelteKit proxy endpoints

Four server routes that validate the session cookie, then forward to the Effect API with the Bearer token:

- `packages/web/src/routes/api/balance/+server.ts` — GET, proxies to Effect API `/api/balance`
- `packages/web/src/routes/api/positions/+server.ts` — GET, proxies to Effect API `/api/positions`
- `packages/web/src/routes/api/bet/+server.ts` — POST, proxies to Effect API `/api/bet`
- `packages/web/src/routes/api/sell/+server.ts` — POST, proxies to Effect API `/api/sell`

Each follows the same pattern:

```ts
// Example: /api/balance/+server.ts
import { auth } from "$lib/auth";
import { getWalletToken } from "$lib/server/wallet";
import { error } from "@sveltejs/kit";

export async function GET({ request }) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw error(401, "Not authenticated");
  const token = await getWalletToken(session.user.email, session.user.name);
  const res = await fetch(`${EFFECT_API_URL}/api/balance`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
}
```

### 4.5 Create `packages/web/src/lib/server/wallet.ts`

Shared helper for the proxy endpoints:

- Calls Effect API `/api/register` with `{ name, email }` (idempotent)
- Caches the Bearer token in-memory (Map<email, token>) to avoid hitting register on every request
- Returns the Bearer token

---

## Phase 5: Frontend Auth Pages

### 5.1 Rewrite `packages/web/src/routes/(auth)/signup/+page.svelte`

Multi-step:

1. Invite code input
2. Name + email input
3. "Send magic link" → `authClient.signIn.magicLink({ email, name, metadata: { inviteCode } })`
4. Show "Check your email" message

### 5.2 Create `packages/web/src/routes/(auth)/verify/+page.svelte`

Magic link lands here. Verifies token via better-auth, then:

1. Session is now active (cookie set by better-auth)
2. Optionally prompt "Add passkey for faster login?" → `authClient.passkey.addPasskey()`
3. Redirect to `/`

### 5.3 Rewrite `packages/web/src/routes/(auth)/login/+page.svelte`

- Primary: "Sign in with passkey" → `authClient.signIn.passkey()`
- Fallback: email input → "Send magic link"
- After either succeeds → redirect to `/`

### 5.4 Update route guard `packages/web/src/routes/(app)/+layout.ts`

Currently checks localStorage for token. Change to check better-auth session:

- Use a `+layout.server.ts` that reads `event.locals.session` (set in hooks.server.ts)
- If no session → redirect to `/login`

### 5.5 Remove localStorage auth

- Remove or gut `packages/web/src/lib/stores/auth.svelte.ts` — replace with better-auth's `authClient.useSession()` reactive store
- Update `packages/web/src/lib/api.ts` — remove `authHeaders()`, remove `register()`. The remaining functions (`fetchMarkets`, `placeBet`, `fetchPositions`) no longer need to attach Bearer tokens — the proxy handles it. They just call the same URL paths and SvelteKit routes to the proxy.

### 5.6 Update components

- `balance.svelte` — fetch from `/api/balance` (now hits the proxy, no auth header needed from client)
- `market-stream.svelte` — SSE stream (`/events/stream`) is public, no changes
- Header/layout — use `authClient.useSession()` instead of `auth.isLoggedIn` for showing logged-in state

---

## Files Summary

| File                                                 | Change                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Web: Infra**                                       |                                                                              |
| `packages/web/package.json`                          | Add adapter-node, better-auth, better-sqlite3, resend; remove adapter-static |
| `packages/web/svelte.config.js`                      | Switch to adapter-node                                                       |
| `packages/web/Dockerfile`                            | Node runtime on port 4102 instead of nginx                                   |
| **Web: Auth**                                        |                                                                              |
| `packages/web/src/lib/auth.ts`                       | **NEW** — better-auth server config                                          |
| `packages/web/src/lib/auth-client.ts`                | **NEW** — better-auth client                                                 |
| `packages/web/src/hooks.server.ts`                   | **NEW** — mount svelteKitHandler, populate session                           |
| `packages/web/src/lib/server/invite-store.ts`        | **NEW** — invite code logic                                                  |
| `packages/web/src/lib/server/wallet.ts`              | **NEW** — wallet bridge helper                                               |
| **Web: Proxy**                                       |                                                                              |
| `packages/web/src/routes/api/balance/+server.ts`     | **NEW** — proxy to Effect API                                                |
| `packages/web/src/routes/api/positions/+server.ts`   | **NEW** — proxy to Effect API                                                |
| `packages/web/src/routes/api/bet/+server.ts`         | **NEW** — proxy to Effect API                                                |
| `packages/web/src/routes/api/sell/+server.ts`        | **NEW** — proxy to Effect API                                                |
| **Web: Pages**                                       |                                                                              |
| `packages/web/src/routes/(auth)/signup/+page.svelte` | Rewrite for magic link flow                                                  |
| `packages/web/src/routes/(auth)/login/+page.svelte`  | Rewrite for passkey + magic link                                             |
| `packages/web/src/routes/(auth)/verify/+page.svelte` | **NEW** — magic link landing                                                 |
| `packages/web/src/routes/(app)/+layout.ts`           | Session-based guard instead of localStorage                                  |
| `packages/web/src/routes/(app)/+layout.server.ts`    | **NEW** — pass session to client                                             |
| `packages/web/src/lib/stores/auth.svelte.ts`         | Replace with better-auth session store                                       |
| `packages/web/src/lib/api.ts`                        | Remove auth headers, remove register()                                       |
| `packages/web/src/components/balance.svelte`         | Remove auth header from fetch                                                |
| `packages/web/src/routes/+layout.svelte`             | Use better-auth session for logged-in state                                  |
| **API**                                              |                                                                              |
| `packages/api/src/user-store.ts`                     | Add email field, emailIndex, getByEmail                                      |
| `packages/api/src/router.ts`                         | Make register idempotent (get-or-create by email)                            |
| **Infra**                                            |                                                                              |
| `docker-compose.yml`                                 | Update wpm-web: Node runtime, port 4102, env vars, SQLite volume             |
| `nginx/nginx.conf`                                   | Route auth + trading endpoints to SvelteKit, public to Effect API            |

## Unchanged

- `packages/api/src/auth.ts` — Bearer token validation unchanged
- `packages/api/src/node-client.ts` — unchanged
- `packages/node/*` — zero blockchain changes
- `packages/shared/*` — unchanged
- `packages/web/src/lib/stores/balance.svelte.ts` — unchanged
- `packages/web/src/lib/stores/market-stream.svelte.ts` — unchanged
- `packages/web/src/lib/stores/connection.svelte.ts` — unchanged

## Tech Debt Notes

- **`users.json` is temporary.** Wallet data (RSA keypair, address, Bearer token) currently lives in the Effect API's JSON file store. The long-term path is moving wallet data into SQLite alongside better-auth's user table and reducing the Effect API to a pure blockchain service with no user/auth concept.

## Verification

1. `cd packages/api && bun test` — existing API tests pass
2. `cd packages/web && bun run dev` — dev server starts with adapter-node on port 5173 (vite) / 4102 (preview)
3. Signup: invite code → email + name → magic link email → click → session active → wallet created → redirected to app with balance
4. Add passkey: after signup, prompted to add Touch ID/Face ID
5. Login with passkey: sign in → session active → wallet retrieved → app loads
6. Login with magic link: enter email → click link → session active → app loads
7. Trading: place bet, sell shares, check balance — all work through SvelteKit proxy, no Bearer token in browser
8. Page reload: session cookie persists, no localStorage needed
