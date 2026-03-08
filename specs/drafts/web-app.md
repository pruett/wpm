# Web App — Component Specification

## Overview

The user-facing Progressive Web App (PWA). Mobile-first responsive design served as a static frontend. Users browse markets, buy/sell outcome shares, track their positions, and compete on leaderboards. Authentication via WebAuthn/passkeys. Real-time price updates via SSE.

## Tech Decisions

- **Framework:** TBD (React/Next.js, or similar — to be decided at implementation)
- **Styling:** TBD (Tailwind, etc.)
- **PWA:** Service worker for offline shell, web app manifest for home screen install
- **Auth:** WebAuthn/passkeys via browser API
- **Real-time:** EventSource (SSE) connection to API server

## Pages / Views

### 1. Landing / Onboarding

**Route:** `/`

For unauthenticated users:

- App branding and brief description
- "Join" button → invite code entry
- "Sign In" button → passkey login

### 2. Onboarding Flow

**Route:** `/join`

Step-by-step:

1. Enter invite code → validate against API
2. Enter name and email
3. Create passkey (browser WebAuthn prompt)
4. Success screen: "Welcome! You received 100,000 WPM" with confetti or similar
5. Redirect to home

### 3. Home / Markets

**Route:** `/markets`

The main screen. Shows all open markets grouped by sport and date.

Each market card displays:

- Teams (with logos if available, otherwise text)
- Game start time (with "closes in X hours" countdown)
- Current odds: probability % for each outcome
- Payout multiplier for each outcome
- Total volume traded
- User's position (if any): shares held, estimated value

**Sorting/filtering:**

- By sport (NFL, NBA, etc.)
- By start time (soonest first — default)
- "My bets" filter (only show markets where user has a position)

**Real-time:** SSE updates prices on all visible market cards without page refresh.

### 4. Market Detail

**Route:** `/markets/:marketId`

Full view of a single market:

**Header:**

- Teams, sport, game start time
- Market status badge (open / closed / resolved / cancelled)

**Odds Panel:**

- Large display of current probability for each outcome
- Payout multiplier for each outcome
- Price chart showing historical odds movement (optional, nice-to-have)

**Trading Panel:**

- Toggle: Buy / Sell
- Buy mode:
  - Select outcome (A or B)
  - Enter WPM amount
  - Preview shows: shares received, effective price, price impact, fee
  - "Place Bet" button
- Sell mode:
  - Select outcome (A or B)
  - Enter share amount (or "sell all")
  - Preview shows: WPM received, effective price, fee
  - "Sell Shares" button

**My Position:**

- Shares held (A and B)
- Cost basis
- Current estimated value
- Unrealized P&L

**Market Activity:**

- Recent trades (anonymized or with names — TBD)
- Total volume

### 5. Portfolio / My Bets

**Route:** `/portfolio`

Overview of all user's positions:

**Active Positions:**

- List of markets where user holds shares
- For each: market name, shares held, current value, unrealized P&L

**Resolved Bets:**

- Historical results
- For each: market name, outcome, shares held, payout received, net P&L

**Summary Stats:**

- Total portfolio value (balance + open position value)
- All-time P&L
- Win rate
- Best/worst bet

### 6. Leaderboard

**Route:** `/leaderboard`

Two tabs:

**All-Time:**

- Ranked by total WPM (balance + estimated position value)
- Shows: rank, name, total WPM, change indicator

**Weekly:**

- Ranked by weekly profit/loss
- Shows: rank, name, weekly P&L, number of bets
- Resets every Monday at 12:00 AM ET

### 7. Wallet

**Route:** `/wallet`

- Current WPM balance (large display)
- "Send WPM" button → transfer flow
- Transaction history (paginated, filterable by type)
- Each transaction shows: type, amount, counterparty, timestamp

**Transfer Flow:**

- Enter recipient (by name search or wallet address)
- Enter amount
- Confirm → execute

### 8. Profile / Settings

**Route:** `/profile`

- Name, email
- Invite code: user's personal referral code + share button
- Referral stats: how many friends invited, total rewards earned
- Manage passkeys (add a new device, etc.)

## Authentication Flow

### First Visit (Registration)

```
1. User navigates to /join
2. Enters invite code → POST /auth/register/validate-code
3. Enters name + email
4. Browser prompts for passkey creation (WebAuthn navigator.credentials.create())
5. Credential sent to POST /auth/register/complete
6. Server creates wallet, processes airdrop + referral
7. JWT returned, stored in memory (not localStorage for security)
8. User redirected to /markets
```

### Return Visit (Login)

```
1. User navigates to /
2. Clicks "Sign In"
3. POST /auth/login/challenge → server returns challenge
4. Browser prompts for passkey (WebAuthn navigator.credentials.get())
5. Signed challenge sent to POST /auth/login/verify
6. JWT returned
7. User redirected to /markets
```

### Session Management

- JWT stored in memory (refreshed on page load if needed)
- 7-day expiry
- On token expiry: prompt passkey re-auth (seamless — just a biometric tap)
- No "remember me" — passkeys make re-auth frictionless

## Real-Time Updates

### SSE Connection

On app load (after auth), open an SSE connection:

```javascript
const eventSource = new EventSource("/events/stream", {
  headers: { Authorization: `Bearer ${token}` },
});

eventSource.addEventListener("price_update", (e) => {
  const data = JSON.parse(e.data);
  // Update market card odds in real-time
});

eventSource.addEventListener("market_created", (e) => {
  // Add new market card to the list
});

eventSource.addEventListener("market_resolved", (e) => {
  // Update market status, show result
});
```

### Reconnection

SSE has built-in reconnection. If the connection drops, the browser automatically reconnects. The server sends a `Last-Event-ID` to allow the client to catch up on missed events.

## PWA Configuration

### Web App Manifest

```json
{
  "name": "Wampum",
  "short_name": "WPM",
  "start_url": "/markets",
  "display": "standalone",
  "theme_color": "#000000",
  "background_color": "#000000"
}
```

### Service Worker

- Cache app shell (HTML, CSS, JS) for offline loading
- API requests are network-first (no stale data for balances/odds)
- Push notification support (future)

## UI Components

### Market Card

Compact card for market list views:

```
┌──────────────────────────────┐
│ NFL • Sun 4:25 PM ET         │
│ Chiefs vs Eagles             │
│                              │
│  Chiefs 62%    Eagles 38%    │
│  1.61x         2.63x        │
│                              │
│ Volume: 5,230 WPM            │
│ Your position: 50 shares (A) │
└──────────────────────────────┘
```

### Trading Panel

```
┌──────────────────────────────┐
│  [Buy]  [Sell]               │
│                              │
│  ○ Chiefs win    ● Eagles win│
│                              │
│  Amount: [____100____] WPM   │
│                              │
│  You receive: 147.06 shares  │
│  Avg price:   0.68 WPM/share │
│  Price impact: +2.3%         │
│  Fee:         1.00 WPM       │
│                              │
│  [ Place Bet ]               │
└──────────────────────────────┘
```

### Leaderboard Row

```
┌──────────────────────────────┐
│ #1  Kevin     1,247,500 WPM  │
│ #2  Bob         985,200 WPM  │
│ #3  Alice       812,300 WPM  │
└──────────────────────────────┘
```

## Error States

- **Network error:** Banner at top "Connection lost. Reconnecting..."
- **Market closed:** Trading panel disabled with "Betting closed" message
- **Insufficient balance:** Inline error on trading panel, "Place Bet" button disabled
- **Session expired:** Modal overlay with "Tap to sign in" → passkey prompt

## Verification Criteria

1. **Onboarding** completes end-to-end: invite code → passkey → airdrop → home screen
2. **Market prices** update in real-time via SSE without page refresh
3. **Trading preview** matches actual trade execution (shares received, fee, etc.)
4. **Leaderboard** rankings match on-chain balances
5. **PWA** installs to home screen and loads app shell offline
6. **Passkey auth** works on iOS Safari, Android Chrome, desktop browsers
7. **Mobile-first** layout renders correctly on 375px width and up
8. **Portfolio** accurately reflects all open positions and historical results
