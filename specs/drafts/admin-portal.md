# Admin Portal — Component Specification

## Overview

Full administrative interface for the chain operator (Kevin). Provides "god mode" control over the WPM system: token distribution, market management, user management, invite codes, oracle oversight, and system health monitoring. Accessible only with admin authentication, separate from the standard user passkey flow.

## Authentication

Admin auth is separate from user passkeys. Options (choose at implementation time):
- **Static API key** stored in environment variable, entered on the admin login page
- **Dedicated admin passkey** registered during system setup

The admin portal can be:
- A separate route within the web app (`/admin/*`) protected by role check
- A completely separate app on a different subdomain (`admin.wpm.example.com`)

Recommendation: same app, `/admin/*` routes, with a role check on the JWT (`role === "admin"`).

## Sections

### 1. Dashboard

**Route:** `/admin`

At-a-glance system overview:

- **Treasury balance** and total supply breakdown (treasury / distributed / seeded in markets)
- **Active markets** count, with total volume
- **Users** count, signups this week
- **Oracle status**: last ingest run, last resolve run, next scheduled run
- **Node health**: chain height, mempool size, uptime
- **Recent activity feed**: last 20 transactions across the system

### 2. Treasury Management

**Route:** `/admin/treasury`

- Current treasury balance
- Distribution history (table: recipient, amount, reason, timestamp)
- **Distribute tokens** form:
  - Select recipient (dropdown of all users, searchable by name)
  - Enter amount
  - Select reason: "manual" (free-form note)
  - Confirm → submits `Distribute` transaction
- Supply breakdown chart:
  - Treasury (unallocated)
  - Distributed to users
  - Locked in active market pools
  - Referral rewards paid

### 3. Market Management

**Route:** `/admin/markets`

Table of all markets (open, resolved, cancelled) with filters and search.

**Columns:** Market ID, sport, teams, status, start time, volume, seed amount, created at

**Actions per market:**
- **View** → full market detail with pool state, all positions, all trades
- **Cancel** → opens confirmation modal with reason field → submits `CancelMarket`
- **Manually resolve** → select winning outcome, enter final score → submits `ResolveMarket`
- **Pause betting** → temporarily prevents new bets (market stays visible but trading panel disabled)
- **Resume betting** → re-enables trading
- **Override seed** → change seed amount for future markets (or add liquidity to existing market)

**Create manual market** (future feature, not MVP):
- Form to create a custom market not tied to ESPN data
- Enter: title, outcome A label, outcome B label, close time, seed amount

### 4. User Management

**Route:** `/admin/users`

Table of all users.

**Columns:** Name, email, wallet address, balance, signup date, invited by, status

**Actions per user:**
- **View** → full user detail: balance, positions, transaction history, referral stats
- **Distribute tokens** → quick distribute form
- **View transactions** → filtered transaction history for this user

### 5. Invite Codes

**Route:** `/admin/invites`

- **Generate codes** button → specify count, max uses per code, optional referrer (link code to a user for referral rewards)
- Table of all codes: code, created at, status (active/used/expired), used by, referrer, use count / max uses
- **Deactivate** code → prevents future use
- **Copy code** → clipboard
- **Share link** → generates a URL like `https://wpm.example.com/join?code=ABC123`

### 6. Oracle Control

**Route:** `/admin/oracle`

- **Schedule display**: current ingest/resolve cron schedules
- **Last run** timestamps for ingest and resolve
- **Run history**: table of recent oracle runs with status (success/failure), games processed, markets created/resolved
- **Manual trigger** buttons:
  - "Run Ingest Now" → triggers ingest job immediately
  - "Run Resolve Now" → triggers resolve job immediately
- **Enabled sports** toggle list (NFL enabled, NBA disabled, etc.)
- **ESPN connectivity** test button

### 7. System Health

**Route:** `/admin/system`

- **Node status**: running/stopped, uptime, memory usage
- **Chain stats**: block height, total transactions, total blocks, chain file size
- **Mempool**: current size, pending transactions
- **Docker container** statuses (if accessible)
- **Logs viewer**: tail of recent node/oracle/API logs (last 100 lines per service)

## Admin API Endpoints

All endpoints require admin auth. Documented fully in `api-server.md` under Admin Endpoints. Key additions for admin portal:

```
POST /admin/oracle/ingest     — Manually trigger ingest
POST /admin/oracle/resolve    — Manually trigger resolve
GET  /admin/oracle/status     — Last run times, schedule
GET  /admin/oracle/history    — Recent run log

POST /admin/markets/:id/pause   — Pause betting
POST /admin/markets/:id/resume  — Resume betting

GET  /admin/system/health     — Full system health
GET  /admin/system/logs/:service?lines=100  — Recent logs
```

## Verification Criteria

1. **Admin auth** rejects non-admin users from all `/admin/*` routes and endpoints
2. **Token distribution** correctly submits `Distribute` transactions and updates balances
3. **Market cancellation** triggers full refund flow
4. **Manual resolution** correctly resolves market and triggers settlement
5. **Invite code generation** produces unique, functional codes
6. **Oracle manual triggers** successfully run ingest/resolve jobs
7. **System health** accurately reflects node and service status
8. **All admin actions** are logged and visible in the activity feed
