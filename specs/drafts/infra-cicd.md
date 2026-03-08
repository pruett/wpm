# CI/CD & Infrastructure — Component Specification

## Overview

The WPM system is a TypeScript monorepo managed by Bun workspaces and Turborepo. It runs on a single Hetzner VPS, orchestrated by Docker Compose. Nginx handles TLS termination and routing. GitHub Actions automates build, test, and deploy on push to `main`.

## Monorepo Structure

Bun workspaces handle package linking. Turborepo provides dependency-aware build orchestration and caching.

### Packages

| Package           | Name          | Purpose                                  | Dependencies               |
| ----------------- | ------------- | ---------------------------------------- | -------------------------- |
| `packages/shared` | `@wpm/shared` | Types, constants, AMM math, crypto utils | None                       |
| `packages/node`   | `@wpm/node`   | Blockchain node process                  | `@wpm/shared`              |
| `packages/api`    | `@wpm/api`    | HTTP API server                          | `@wpm/shared`              |
| `packages/oracle` | `@wpm/oracle` | Oracle server (ingest + resolve)         | `@wpm/shared`              |
| `packages/web`    | `@wpm/web`    | Frontend PWA                             | `@wpm/shared` (types only) |

### Boundary Rule

| Package  | Contains                                                                 | Does NOT contain                                 |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| `shared` | Types, interfaces, constants, pure math (AMM), crypto primitives         | No I/O, no HTTP, no persistence, no side effects |
| `node`   | Chain state, block production, validation, settlement, JSONL persistence | No HTTP routing, no auth                         |
| `api`    | HTTP routes, auth, session management, SSE, request validation           | No chain logic, no direct chain state            |
| `oracle` | ESPN fetching, game parsing, job scheduling                              | No chain logic, no user-facing anything          |
| `web`    | UI components, pages, browser APIs                                       | No server-side logic                             |

The `api` talks to `node` over HTTP (via an internal client). It never imports node internals — only `@wpm/shared` types. This enforces the Docker container boundary at the code level.

## Infrastructure Layout

```
┌──────────────────────────────────────────────────────┐
│                     Hetzner VPS                       │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │                    Nginx                         │  │
│  │  :443 → TLS termination                         │  │
│  │  /api/*        → wpm-api:3000                   │  │
│  │  /events/*     → wpm-api:3000 (SSE)             │  │
│  │  /admin/api/*  → wpm-api:3000                   │  │
│  │  /*            → wpm-web:80 (static files)      │  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │  wpm-node  │  │  wpm-api   │  │   wpm-oracle    │  │
│  │            │  │            │  │                  │  │
│  │ Blockchain │◄─┤ HTTP API   │  │ Ingest + Resolve│  │
│  │ process    │  │ server     │  │ (cron-driven)   │  │
│  │            │  │            │  │                  │  │
│  │ :4000      │  │ :3000      │  │ No exposed port │  │
│  └─────┬──────┘  └────────────┘  └─────────────────┘  │
│        │                                               │
│        ▼                                               │
│  ┌─────────────┐  ┌────────────┐                      │
│  │ chain.jsonl  │  │  wpm-web   │                      │
│  │ (volume)     │  │ (static)   │                      │
│  │              │  │ :80        │                      │
│  └──────────────┘  └────────────┘                      │
│                                                       │
│  Docker internal network: wpm-net                     │
└──────────────────────────────────────────────────────┘
```

## Docker Compose

### Services

```yaml
services:
  wpm-node:
    build:
      context: .
      dockerfile: packages/node/Dockerfile
    restart: unless-stopped
    volumes:
      - chain-data:/data
      - keys:/keys
    environment:
      - NODE_PORT=4000
      - CHAIN_FILE=/data/chain.jsonl
      - SIGNER_KEY_PATH=/keys/signer.pem
      - ORACLE_PUBLIC_KEY_PATH=/keys/oracle.pub
    networks:
      - wpm-net

  wpm-api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    restart: unless-stopped
    depends_on:
      - wpm-node
    environment:
      - API_PORT=3000
      - NODE_URL=http://wpm-node:4000
      - JWT_SECRET=${JWT_SECRET}
      - TREASURY_KEY_PATH=/keys/signer.pem
    volumes:
      - keys:/keys
    networks:
      - wpm-net

  wpm-oracle:
    build:
      context: .
      dockerfile: packages/oracle/Dockerfile
    restart: unless-stopped
    depends_on:
      - wpm-api
    environment:
      - API_URL=http://wpm-api:3000
      - ORACLE_KEY_PATH=/keys/oracle.pem
      - ENABLED_SPORTS=NFL
      - INGEST_CRON=0 6 * * *
      - RESOLVE_CRON=*/30 12-24 * * *
      - LOOKAHEAD_DAYS=14
      - DEFAULT_SEED_AMOUNT=1000
      - TZ=America/New_York
    volumes:
      - keys:/keys
    networks:
      - wpm-net

  wpm-web:
    build:
      context: .
      dockerfile: packages/web/Dockerfile
    restart: unless-stopped
    networks:
      - wpm-net

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
      - ./nginx/certs:/etc/nginx/certs
    depends_on:
      - wpm-api
      - wpm-web
    networks:
      - wpm-net

volumes:
  chain-data:
  keys:

networks:
  wpm-net:
    driver: bridge
```

Note: Docker build context is the repo root (`.`) so that each Dockerfile can copy `packages/shared` for the build. Each Dockerfile specifies its own path via `dockerfile:`.

### Volume Strategy

- **chain-data**: Persistent volume for `chain.jsonl`. Survives container restarts and redeployments.
- **keys**: Persistent volume for RSA keys (PoA signer, oracle). Generated once at system init, never regenerated.

## Nginx Configuration

```nginx
server {
    listen 443 ssl;
    server_name wpm.example.com;

    ssl_certificate /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    # API routes
    location /api/ {
        proxy_pass http://wpm-api:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # SSE — long-lived connections
    location /events/ {
        proxy_pass http://wpm-api:3000/events/;
        proxy_set_header Host $host;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # Web app (static files)
    location / {
        proxy_pass http://wpm-web:80/;
    }
}

server {
    listen 80;
    server_name wpm.example.com;
    return 301 https://$host$request_uri;
}
```

### TLS

- **Let's Encrypt** via certbot (run manually or via a certbot container)
- Auto-renewal via cron on the VPS

## CI/CD — GitHub Actions

### Pipeline

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bunx turbo test

  build-and-deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push images
        run: |
          docker compose build
          docker compose push

      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/wpm
            docker compose pull
            docker compose up -d --remove-orphans
```

### Secrets (GitHub)

| Secret        | Purpose                        |
| ------------- | ------------------------------ |
| `VPS_HOST`    | Hetzner server IP              |
| `VPS_USER`    | SSH user on VPS                |
| `VPS_SSH_KEY` | SSH private key for deployment |

### Image Registry

- GitHub Container Registry (`ghcr.io`)
- Free for private repos
- Images tagged with `latest` on each push to main

## Environment Configuration

### VPS Setup (One-Time)

1. Provision Hetzner VPS (CX21 or similar — 2 vCPU, 4GB RAM, ~$7/mo)
2. Install Docker and Docker Compose
3. Clone repo to `/opt/wpm`
4. Generate keys: `./scripts/init-keys.sh` (creates PoA signer + oracle RSA key pairs)
5. Set environment variables in `.env` (JWT_SECRET, etc.)
6. Run `docker compose up -d`
7. Set up Let's Encrypt certs
8. Point domain DNS to VPS IP

### Environment Variables

```bash
# .env (on VPS, not committed to repo)
JWT_SECRET=<random-64-char-string>
DOMAIN=wpm.example.com
TZ=America/New_York
```

### Init Script

`scripts/init-keys.sh`:

1. Generate PoA signer RSA key pair → `/keys/signer.pem`, `/keys/signer.pub`
2. Generate oracle RSA key pair → `/keys/oracle.pem`, `/keys/oracle.pub`
3. Generate genesis block with treasury allocation
4. Write initial `chain.jsonl` with genesis block

This runs once. Keys and chain data persist in Docker volumes.

## Project Structure

```
wpm/
├── package.json                  # Root — bun workspaces
├── turbo.json                    # Turborepo pipeline
├── tsconfig.json                 # Base TypeScript config
├── docker-compose.yml
├── .env.example
├── .gitignore
├── ARCHITECTURE.md
├── specs/
│   ├── blockchain-node.md
│   ├── settlement-engine.md
│   ├── api-server.md
│   ├── oracle-server.md
│   ├── web-app.md
│   ├── admin-portal.md
│   └── infra-cicd.md
├── packages/
│   ├── shared/                   # @wpm/shared
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types/
│   │       │   ├── block.ts
│   │       │   ├── transaction.ts
│   │       │   ├── market.ts
│   │       │   └── index.ts
│   │       ├── amm/
│   │       │   ├── pool.ts
│   │       │   ├── pricing.ts
│   │       │   └── index.ts
│   │       ├── crypto/
│   │       │   ├── keys.ts
│   │       │   ├── hash.ts
│   │       │   └── index.ts
│   │       ├── constants.ts
│   │       └── index.ts
│   ├── node/                     # @wpm/node
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── chain/
│   │       │   ├── blockchain.ts
│   │       │   ├── block.ts
│   │       │   ├── mempool.ts
│   │       │   └── state.ts
│   │       ├── settlement/
│   │       │   ├── engine.ts
│   │       │   └── refund.ts
│   │       ├── persistence/
│   │       │   ├── writer.ts
│   │       │   └── replay.ts
│   │       ├── server.ts
│   │       └── index.ts
│   ├── api/                      # @wpm/api
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── auth.ts
│   │       │   ├── markets.ts
│   │       │   ├── wallet.ts
│   │       │   ├── leaderboard.ts
│   │       │   ├── admin.ts
│   │       │   └── events.ts
│   │       ├── middleware/
│   │       │   ├── auth.ts
│   │       │   └── admin.ts
│   │       ├── services/
│   │       │   ├── node-client.ts
│   │       │   ├── webauthn.ts
│   │       │   └── wallet.ts
│   │       ├── server.ts
│   │       └── index.ts
│   ├── oracle/                   # @wpm/oracle
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── adapters/
│   │       │   ├── adapter.ts
│   │       │   ├── nfl.ts
│   │       │   └── index.ts
│   │       ├── jobs/
│   │       │   ├── ingest.ts
│   │       │   └── resolve.ts
│   │       ├── scheduler.ts
│   │       └── index.ts
│   └── web/                      # @wpm/web
│       ├── package.json
│       ├── tsconfig.json
│       ├── Dockerfile
│       └── src/
│           ├── app/
│           ├── components/
│           ├── hooks/
│           └── lib/
│               ├── api.ts
│               ├── sse.ts
│               └── webauthn.ts
├── nginx/
│   └── nginx.conf
├── scripts/
│   └── init-keys.sh
└── .github/
    └── workflows/
        └── deploy.yml
```

## Developer Workflow

```bash
# Install all dependencies
bun install

# Run all tests (dependency-ordered)
bunx turbo test

# Run a specific service in dev
bunx turbo dev --filter=@wpm/api

# Build everything (dependency-ordered)
bunx turbo build

# Build just one package and its deps
bunx turbo build --filter=@wpm/api
```

## Monitoring (Minimal)

- **Health check endpoint**: `/admin/system/health` (API server queries node status)
- **Docker restart policy**: `restart: unless-stopped` on all services
- **Logs**: `docker compose logs -f <service>` for debugging
- Future: simple uptime check (e.g. UptimeRobot free tier pinging the health endpoint)

## Backup Strategy

- **chain.jsonl** is the complete system backup
- Cron job on VPS: daily copy of `chain.jsonl` to a backup location (e.g. S3, another server, or local backup dir)
- The JSONL file is append-only and small — at low activity, it grows by KB/day

## Verification Criteria

1. **Bun workspaces** resolve cross-package imports correctly (`@wpm/shared` importable from all packages)
2. **Turborepo** builds in correct dependency order (shared → node/api/oracle/web)
3. **Docker Compose** brings up all services with `docker compose up -d`
4. **Docker builds** succeed with monorepo context (shared code copied into each image)
5. **Services** can communicate over the internal network
6. **Nginx** correctly routes API, SSE, and web traffic
7. **TLS** works end-to-end (HTTPS only, HTTP redirects)
8. **GitHub Actions** runs tests, builds images, and deploys on push to main
9. **Persistence** survives container restarts (`chain.jsonl` and keys intact)
10. **Init script** generates valid keys and genesis block
11. **Zero-downtime deploy** — new containers start before old ones stop
