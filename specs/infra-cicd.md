# CI/CD & Infrastructure Specification

> **System:** WPM (Wampum) Prediction Market Platform
> **Status:** Draft
> **Last updated:** 2026-03-06
> **Source:** [ARCHITECTURE.md](/ARCHITECTURE.md)

## 1. Overview

The CI/CD & Infrastructure component encompasses the monorepo tooling, containerization, reverse proxy, deployment pipeline, and server provisioning that make the WPM platform operational. It is not a single runtime service but rather the scaffolding that builds, connects, deploys, and operates every other component. Without it, individual packages cannot be built, linked, tested, deployed, or reached by users.

This spec covers six sub-components:

1. **Monorepo structure** -- Bun workspaces + Turborepo
2. **Docker Compose orchestration** -- container definitions, networking, volumes
3. **Nginx reverse proxy** -- TLS termination, routing, SSE support
4. **GitHub Actions CI/CD pipeline** -- test, build, push, deploy
5. **Hetzner VPS provisioning** -- one-time setup, OS-level configuration
6. **Key & volume management** -- RSA keys, chain data persistence, backups

## 2. Context

### System Context Diagram

```
                         Internet
                            |
                     ┌──────┴──────┐
                     │   DNS (A)   │
                     │wpm.example  │
                     │  .com (TBD) │
                     └──────┬──────┘
                            |
               ┌────────────┴────────────────┐
               |       Hetzner VPS           |
               |   ┌────────────────────┐    |
               |   |      Nginx        |    |
               |   |  :443 TLS term    |    |
               |   |  :80 → 301 HTTPS  |    |
               |   └──┬─────┬──────┬───┘    |
               |      |     |      |         |
               |   /api/* /events/* /*       |
               |      |     |      |         |
               |      v     v      v         |
               |  ┌──────┐    ┌──────────┐   |
               |  |wpm-  |    | wpm-web  |   |
               |  | api  |    | (static) |   |
               |  |:3000 |    |  :80     |   |
               |  └──┬───┘    └──────────┘   |
               |     |                        |
               |     v                        |
               |  ┌──────┐  ┌────────────┐   |
               |  |wpm-  |  | wpm-oracle |   |
               |  | node |  |  :3001     |   |
               |  |:4000 |  └─────┬──────┘   |
               |  └──┬───┘        |           |
               |     |            v           |
               |     |     http://wpm-api     |
               |     v            :3000       |
               |  ┌──────────┐                |
               |  |chain.jsonl|               |
               |  |  (vol)   |                |
               |  └──────────┘                |
               |                              |
               |  Docker network: wpm-net     |
               └──────────────────────────────┘

GitHub Actions ──SSH──> VPS (deploy)
GitHub Actions ──push──> ghcr.io (images)
VPS ──pull──> ghcr.io (images)
```

### Assumptions

- Single-server deployment. No horizontal scaling, no load balancer, no multi-region.
- Low traffic: a small friend group (~10-50 users). Resource contention is not a concern.
- The VPS has a stable public IPv4 address.
- GitHub is the sole source control and CI/CD platform.
- All services run as Docker containers on the same host, communicating over a bridge network.
- Let's Encrypt is used for TLS; the domain is publicly resolvable.
- Domain is TBD. `wpm.example.com` is used as a placeholder throughout this spec and in the Nginx config. The placeholder will be updated when a domain is chosen.
- Bun is the package manager and runtime for all TypeScript packages.

### Constraints

- **Single VPS**: Hetzner CX21 (2 vCPU, 4 GB RAM, 40 GB disk, ~$7/mo). All services must fit within this resource envelope. Hetzner allows live resizing to a larger plan if more resources are needed -- no migration or downtime required.
- **No external database**: Chain state is in `chain.jsonl` and in-memory. `wpm-api` uses SQLite for auth data (users, credentials, invite codes). No PostgreSQL, Redis, or similar.
- **No container orchestrator**: Docker Compose only. No Kubernetes, no Swarm.
- **Bun workspaces**: All packages must be linkable via Bun's workspace resolution. No Yarn, no pnpm.
- **Single branch deployment**: Only `main` triggers CI/CD. No staging environment.

## 3. Functional Requirements

### FR-1: Monorepo Package Resolution

**Description:** Bun workspaces must resolve cross-package imports so that any package can import `@wpm/shared` without publishing to a registry.

**Configuration:**

Root `package.json`:

```json
{
  "name": "wpm",
  "private": true,
  "workspaces": ["packages/*"]
}
```

Each package's `package.json` declares its workspace dependency:

```json
{
  "name": "@wpm/api",
  "dependencies": {
    "@wpm/shared": "workspace:*"
  }
}
```

**Packages:**

| Package           | Name          | Purpose                                                      | Workspace Dependencies |
| ----------------- | ------------- | ------------------------------------------------------------ | ---------------------- |
| `packages/shared` | `@wpm/shared` | Types, constants, AMM math, crypto utils                     | None                   |
| `packages/node`   | `@wpm/node`   | Blockchain node process                                      | `@wpm/shared`          |
| `packages/api`    | `@wpm/api`    | HTTP API server                                              | `@wpm/shared`          |
| `packages/oracle` | `@wpm/oracle` | Oracle server (ingest + resolve)                             | `@wpm/shared`          |
| `packages/web`    | `@wpm/web`    | Frontend PWA (React + Vite + vite-plugin-pwa + Tailwind CSS) | `@wpm/shared`          |

**Boundary Rules:**

| Package  | Contains                                                                 | Must NOT Contain                         |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `shared` | Types, interfaces, constants, pure math (AMM), crypto primitives         | I/O, HTTP, persistence, side effects     |
| `node`   | Chain state, block production, validation, settlement, JSONL persistence | HTTP routing, auth                       |
| `api`    | HTTP routes, auth, session management, SSE, request validation           | Chain logic, direct chain state mutation |
| `oracle` | ESPN fetching, game parsing, job scheduling                              | Chain logic, user-facing endpoints       |
| `web`    | UI components, pages, browser APIs                                       | Server-side logic                        |

The `api` package communicates with `node` over HTTP via an internal client (`node-client.ts`). It never imports `@wpm/node` directly. This enforces the Docker container boundary at the code level.

**Acceptance Criteria:**

- [ ] Given a fresh clone, when `bun install` is run at the repo root, then all workspace symlinks are created and `@wpm/shared` is importable from every other package.
- [ ] Given `@wpm/api` imports a type from `@wpm/shared`, when `bunx turbo build --filter=@wpm/api` is run, then the build succeeds without errors.
- [ ] Given `@wpm/api` attempts to import from `@wpm/node`, then the TypeScript compiler produces an error (enforced by `tsconfig.json` path restrictions).

### FR-2: Turborepo Build Orchestration

**Description:** Turborepo manages build, test, and dev tasks with dependency-aware ordering and local caching.

**Configuration (`turbo.json`):**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    }
  }
}
```

**Build Order:** `@wpm/shared` builds first (no dependencies). Once `shared` completes, `node`, `api`, `oracle`, and `web` can all build in parallel since they each depend only on `shared` and not on each other.

**Acceptance Criteria:**

- [ ] Given all packages are unbuilt, when `bunx turbo build` is run, then `@wpm/shared` builds before all other packages.
- [ ] Given `@wpm/shared` source changes, when `bunx turbo build` is run, then all downstream packages rebuild. When run again with no changes, Turborepo reports cache hits for all packages.
- [ ] Given `bunx turbo test` is run, then tests for all packages execute and exit 0 on a healthy codebase.

### FR-3: Docker Image Builds

**Description:** Each deployable service has a Dockerfile that produces a minimal production image. All Dockerfiles use the repo root as build context to access `packages/shared`.

**Dockerfile Pattern (example for `@wpm/api`):**

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN bun install --frozen-lockfile --production

# Build shared first, then api
COPY packages/shared/ packages/shared/
RUN cd packages/shared && bun run build

COPY packages/api/ packages/api/
RUN cd packages/api && bun run build

# Production stage
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=base /app/packages/api/dist ./dist
COPY --from=base /app/node_modules ./node_modules
EXPOSE 3000
CMD ["bun", "run", "dist/index.js"]
```

**Image naming convention:**

```
ghcr.io/<github-owner>/wpm-node:latest
ghcr.io/<github-owner>/wpm-api:latest
ghcr.io/<github-owner>/wpm-oracle:latest
ghcr.io/<github-owner>/wpm-web:latest
```

The `nginx` service uses the stock `nginx:alpine` image; no custom build.

**Docker Compose image declarations:**
Each service in `docker-compose.yml` must declare both `build` (for local/CI builds) and `image` (for registry push/pull):

```yaml
services:
  wpm-api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    image: ghcr.io/<owner>/wpm-api:latest
```

**Acceptance Criteria:**

- [ ] Given a clean Docker environment, when `docker compose build` is run from the repo root, then all four custom images build successfully.
- [ ] Given a built image for `wpm-api`, when it is run with the required environment variables, then the process starts and listens on port 3000.
- [ ] Given `packages/shared/src` has changed, when any service image is rebuilt, then the image includes the updated shared code.
- [ ] Given a multi-stage build, then the final production image does not contain TypeScript source files, test files, or devDependencies.

### FR-4: Docker Compose Orchestration

**Description:** Docker Compose defines all services, their dependencies, networking, volumes, and environment configuration.

**Service Definitions:**

```yaml
services:
  wpm-node:
    image: ghcr.io/<owner>/wpm-node:latest
    build:
      context: .
      dockerfile: packages/node/Dockerfile
    restart: unless-stopped
    volumes:
      - chain-data:/data
      - keys:/keys:ro
    environment:
      - NODE_PORT=4000
      - CHAIN_FILE=/data/chain.jsonl
      - SIGNER_KEY_PATH=/keys/signer.pem
      - ORACLE_PUBLIC_KEY_PATH=/keys/oracle.pub
    networks:
      - wpm-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/internal/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 15s

  wpm-api:
    image: ghcr.io/<owner>/wpm-api:latest
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    restart: unless-stopped
    depends_on:
      wpm-node:
        condition: service_healthy
    environment:
      - API_PORT=3000
      - NODE_URL=http://wpm-node:4000
      - JWT_SECRET=${JWT_SECRET}
      - ADMIN_API_KEY=${ADMIN_API_KEY}
    volumes:
      - api-data:/data
    networks:
      - wpm-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s

  wpm-oracle:
    image: ghcr.io/<owner>/wpm-oracle:latest
    build:
      context: .
      dockerfile: packages/oracle/Dockerfile
    restart: unless-stopped
    depends_on:
      wpm-api:
        condition: service_healthy
    environment:
      - ORACLE_PORT=3001
      - API_URL=http://wpm-api:3000
      - ORACLE_KEY_PATH=/keys/oracle.pem
      - ENABLED_SPORTS=NFL
      - INGEST_CRON=0 6 * * *
      - RESOLVE_CRON=*/30 12-24 * * *
      - LOOKAHEAD_DAYS=14
      - DEFAULT_SEED_AMOUNT=1000
      - TZ=America/New_York
    expose:
      - "3001"
    volumes:
      - keys:/keys:ro
    networks:
      - wpm-net
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  wpm-web:
    image: ghcr.io/<owner>/wpm-web:latest
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
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/certs:/etc/nginx/certs:ro
    depends_on:
      wpm-api:
        condition: service_healthy
      wpm-web:
        condition: service_started
    networks:
      - wpm-net

volumes:
  chain-data:
  keys:
  api-data:

networks:
  wpm-net:
    driver: bridge
```

**Service startup order:** `wpm-node` (must be healthy) -> `wpm-api` (must be healthy) -> `wpm-oracle`, `nginx`. `wpm-web` has no ordering dependency.

**Key design decisions:**

- Build context is the repo root (`.`) so every Dockerfile can `COPY packages/shared/`.
- Key volumes are mounted `ro` (read-only) except in `wpm-node` which writes `chain-data`.
- Health checks use `curl` against each service's health endpoint with `service_healthy` conditions in `depends_on` to enforce startup sequencing.

**Acceptance Criteria:**

- [ ] Given the VPS has pulled all images, when `docker compose up -d` is run, then all five containers reach `running` status within 60 seconds.
- [ ] Given `wpm-node` is not yet healthy, then `wpm-api` does not start until the node health check passes.
- [ ] Given `wpm-api` is not yet healthy, then `wpm-oracle` does not start until the API health check passes.
- [ ] Given a container crashes, then Docker restarts it automatically (`unless-stopped` policy).
- [ ] Given `docker compose down && docker compose up -d`, then `chain.jsonl` and key files persist across the cycle (volumes are not destroyed).

### FR-5: Volume & Persistence Management

**Description:** Docker named volumes store all persistent state. Three volumes exist:

| Volume       | Mount Point | Owner       | Contents                                               | Write Access                               |
| ------------ | ----------- | ----------- | ------------------------------------------------------ | ------------------------------------------ |
| `chain-data` | `/data`     | `wpm-node`  | `chain.jsonl`                                          | `wpm-node` only                            |
| `keys`       | `/keys`     | Init script | `signer.pem`, `signer.pub`, `oracle.pem`, `oracle.pub` | Init script only (mounted `ro` at runtime) |
| `api-data`   | `/data`     | `wpm-api`   | SQLite database (users, credentials, invite codes)     | `wpm-api` only                             |

**Volume lifecycle:**

- Created on first `docker compose up`.
- Never destroyed by `docker compose down` (requires explicit `docker compose down -v`).
- `chain-data` grows over time; `keys` is static after initialization; `api-data` grows slowly with user registrations.

**Key files:**

| File         | Format                                 | Size    | Purpose                             |
| ------------ | -------------------------------------- | ------- | ----------------------------------- |
| `signer.pem` | PEM-encoded RSA private key (2048-bit) | ~1.7 KB | PoA block signing + treasury wallet |
| `signer.pub` | PEM-encoded RSA public key             | ~0.5 KB | Block signature verification        |
| `oracle.pem` | PEM-encoded RSA private key (2048-bit) | ~1.7 KB | Oracle transaction signing          |
| `oracle.pub` | PEM-encoded RSA public key             | ~0.5 KB | Oracle signature verification       |

**Acceptance Criteria:**

- [ ] Given the init script has been run, when `wpm-node` starts, then it can read `signer.pem` from `/keys/signer.pem` and load a valid RSA private key.
- [ ] Given `docker compose down` (without `-v`) and `docker compose up -d`, then `chain.jsonl` contains all previously written blocks.
- [ ] Given `docker compose down -v` is run, then both volumes are destroyed and the system requires re-initialization.

### FR-6: Nginx Reverse Proxy & TLS

**Description:** Nginx is the only service with exposed ports. It terminates TLS, redirects HTTP to HTTPS, and routes requests to internal services.

**Routing Rules:**

| Path Pattern    | Upstream                         | Protocol | Notes                                               |
| --------------- | -------------------------------- | -------- | --------------------------------------------------- |
| `/api/*`        | `http://wpm-api:3000/`           | HTTP/1.1 | Strip `/api` prefix via `proxy_pass` trailing slash |
| `/events/*`     | `http://wpm-api:3000/events/`    | HTTP/1.1 | SSE: buffering disabled, 24h read timeout           |
| `/admin/api/*`  | `http://wpm-api:3000/admin/api/` | HTTP/1.1 | Admin endpoints, same upstream as API               |
| `/*` (fallback) | `http://wpm-web:80/`             | HTTP/1.1 | Static files (SPA)                                  |

**Full Nginx configuration:**

```nginx
server {
    listen 443 ssl;
    server_name wpm.example.com;

    ssl_certificate /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # API routes
    location /api/ {
        proxy_pass http://wpm-api:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Admin API routes
    location /admin/api/ {
        proxy_pass http://wpm-api:3000/admin/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SSE -- long-lived connections
    location /events/ {
        proxy_pass http://wpm-api:3000/events/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
    }

    # Web app (SPA static files)
    location / {
        proxy_pass http://wpm-web:80/;
        proxy_set_header Host $host;
    }
}

server {
    listen 80;
    server_name wpm.example.com;
    return 301 https://$host$request_uri;
}
```

**SSE-specific configuration rationale:**

- `proxy_buffering off` -- Nginx must not buffer SSE event data; it must stream immediately.
- `proxy_cache off` -- SSE responses must not be cached.
- `chunked_transfer_encoding off` -- SSE uses its own framing; chunked encoding interferes.
- `Connection ''` -- Prevents Nginx from closing the connection prematurely.
- `proxy_read_timeout 86400s` -- Allows the SSE connection to stay open for 24 hours.

**TLS Configuration:**

- Certificate source: Let's Encrypt via certbot.
- Certificate files: `/etc/nginx/certs/fullchain.pem` and `/etc/nginx/certs/privkey.pem`.
- Protocols: TLS 1.2 and 1.3 only.
- Renewal: Cron job on the VPS runs `certbot renew` daily; Nginx reloads on renewal via `--deploy-hook "docker exec nginx nginx -s reload"`.

**Acceptance Criteria:**

- [ ] Given a valid TLS certificate, when a client connects to `https://wpm.example.com/api/markets`, then the request is proxied to `wpm-api:3000/markets` and returns a valid response.
- [ ] Given a client connects to `http://wpm.example.com/anything`, then it receives a 301 redirect to `https://wpm.example.com/anything`.
- [ ] Given a client opens an SSE connection to `/events/`, then the connection stays open for at least 60 minutes without being dropped by Nginx.
- [ ] Given a client requests `/`, then the SPA `index.html` is served from `wpm-web`.
- [ ] Given `wpm-api` is down, then Nginx returns 502 Bad Gateway for `/api/*` routes; `/` still serves static files.
- [ ] Given the response headers, then `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, and `X-XSS-Protection` are all present.

### FR-7: GitHub Actions CI/CD Pipeline

**Description:** A GitHub Actions workflow automates testing, image building, registry push, and deployment on every push to `main`.

**Pipeline stages:**

```
push to main
    |
    v
[1. Test] ──fail──> stop, report failure
    |
  pass
    |
    v
[2. Build & Push] ──fail──> stop, report failure
    |
  pass
    |
    v
[3. Deploy via SSH]
```

**Full workflow (`.github/workflows/deploy.yml`):**

```yaml
name: Deploy

on:
  push:
    branches: [main]

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Run tests
        run: bunx turbo test

      - name: Type check
        run: bunx turbo typecheck

  build-and-deploy:
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      packages: write
      contents: read
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
            docker image prune -f
```

**Key pipeline behaviors:**

- `concurrency.group: deploy` with `cancel-in-progress: false` ensures only one deploy runs at a time. A second push while deploying queues rather than cancels.
- `timeout-minutes` prevents hung jobs from consuming runner minutes.
- `docker image prune -f` on the VPS cleans up old images after deployment.
- `--remove-orphans` removes containers for services that were removed from `docker-compose.yml`.
- `permissions.packages: write` is required to push to ghcr.io.

**GitHub Secrets:**

| Secret         | Type            | Purpose                              | Rotation Policy           |
| -------------- | --------------- | ------------------------------------ | ------------------------- |
| `VPS_HOST`     | String          | Hetzner server IPv4 address          | On VPS replacement        |
| `VPS_USER`     | String          | SSH username on VPS (e.g., `deploy`) | On user rotation          |
| `VPS_SSH_KEY`  | SSH private key | Ed25519 key authorized on VPS        | Annually or on compromise |
| `GITHUB_TOKEN` | Auto-provided   | GHCR authentication                  | Automatic per-run         |

**Image tagging strategy:**

- Every push to `main` tags images as `latest`. No version tags, no SHA tags.
- Rationale: single-server hobby project; `latest` is sufficient. If rollback is needed, rebuild from the previous commit.

**Acceptance Criteria:**

- [ ] Given a push to `main` with all tests passing, when the workflow completes, then all four custom images are pushed to ghcr.io and the VPS is running the new images.
- [ ] Given a push to `main` with a failing test, then the `build-and-deploy` job does not run and no deployment occurs.
- [ ] Given two pushes to `main` in quick succession, then the second deployment waits for the first to finish (no concurrent deploys).
- [ ] Given a push to a branch other than `main`, then the workflow does not trigger.
- [ ] Given the deploy step, when `docker compose up -d` runs on the VPS, then containers are replaced with zero-downtime (Docker Compose recreates containers one at a time by default).

### FR-8: VPS Provisioning (One-Time Setup)

**Description:** The Hetzner VPS requires one-time setup before the CI/CD pipeline can deploy to it.

**Server specification:**

- **Provider:** Hetzner Cloud
- **Plan:** CX21 (2 vCPU, 4 GB RAM, 40 GB disk) -- confirmed starting configuration
- **OS:** Ubuntu 22.04 LTS or later
- **Estimated cost:** ~$7/month
- **Note:** Hetzner allows live resizing to a larger plan if more resources are needed.

**Setup procedure:**

| Step | Command / Action                                                           | Verification                       |
| ---- | -------------------------------------------------------------------------- | ---------------------------------- |
| 1    | Provision VPS in Hetzner Cloud console                                     | SSH accessible via root            |
| 2    | Create deploy user: `adduser deploy && usermod -aG docker deploy`          | `ssh deploy@<ip>` works            |
| 3    | Install Docker: `curl -fsSL https://get.docker.com \| sh`                  | `docker --version` succeeds        |
| 4    | Install Docker Compose plugin: `apt install docker-compose-plugin`         | `docker compose version` succeeds  |
| 5    | Clone repo: `git clone <repo> /opt/wpm && chown -R deploy:deploy /opt/wpm` | `/opt/wpm` exists                  |
| 6    | Copy `.env` to `/opt/wpm/.env` with production values                      | File exists with `JWT_SECRET` set  |
| 7    | Run init script: `cd /opt/wpm && ./scripts/init-keys.sh`                   | Keys exist in Docker volume        |
| 8    | Start services: `docker compose up -d`                                     | All containers running             |
| 9    | Install certbot: `apt install certbot`                                     | `certbot --version` succeeds       |
| 10   | Obtain certificate: `certbot certonly --standalone -d wpm.example.com`     | Certs in `/etc/letsencrypt`        |
| 11   | Symlink or copy certs to `./nginx/certs/`                                  | Nginx starts with TLS              |
| 12   | Configure certbot renewal cron                                             | `certbot renew --dry-run` succeeds |
| 13   | Point domain A record to VPS IP                                            | `dig wpm.example.com` resolves     |
| 14   | Add deploy user's SSH public key to `~deploy/.ssh/authorized_keys`         | CI/CD SSH step works               |
| 15   | Configure firewall: `ufw allow 22,80,443/tcp && ufw enable`                | Only SSH/HTTP/HTTPS open           |

**Init script (`scripts/init-keys.sh`):**

```bash
#!/usr/bin/env bash
set -euo pipefail

VOLUME_PATH=$(docker volume inspect wpm_keys --format '{{ .Mountpoint }}' 2>/dev/null || true)

if [ -z "$VOLUME_PATH" ]; then
  echo "Creating keys volume..."
  docker volume create wpm_keys
  VOLUME_PATH=$(docker volume inspect wpm_keys --format '{{ .Mountpoint }}')
fi

if [ -f "$VOLUME_PATH/signer.pem" ]; then
  echo "Keys already exist. Aborting to prevent overwrite."
  exit 1
fi

echo "Generating PoA signer key pair..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$VOLUME_PATH/signer.pem"
openssl rsa -pubout -in "$VOLUME_PATH/signer.pem" -out "$VOLUME_PATH/signer.pub"

echo "Generating oracle key pair..."
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$VOLUME_PATH/oracle.pem"
openssl rsa -pubout -in "$VOLUME_PATH/oracle.pem" -out "$VOLUME_PATH/oracle.pub"

chmod 600 "$VOLUME_PATH/signer.pem" "$VOLUME_PATH/oracle.pem"
chmod 644 "$VOLUME_PATH/signer.pub" "$VOLUME_PATH/oracle.pub"

echo "Keys generated successfully."
echo "Next: start wpm-node to generate genesis block on first boot."
```

The genesis block (minting 10,000,000 WPM to treasury) is generated by `wpm-node` on first startup when `chain.jsonl` does not exist -- not by the init script. The init script only handles key generation.

**Acceptance Criteria:**

- [ ] Given a freshly provisioned VPS, when all setup steps are completed, then `docker compose up -d` starts all services and `https://wpm.example.com` is reachable.
- [ ] Given the init script is run, when `signer.pem` already exists, then the script aborts with an error (no overwrite).
- [ ] Given the init script is run on a fresh volume, then four key files are created with correct permissions (private keys 600, public keys 644).
- [ ] Given the firewall is configured, then only ports 22, 80, and 443 are open.

### FR-9: Environment Configuration

**Description:** Runtime configuration is passed via environment variables. Secrets are never committed to the repository.

**Environment variable inventory:**

| Variable                 | Service    | Source             | Default                | Required |
| ------------------------ | ---------- | ------------------ | ---------------------- | -------- |
| `NODE_PORT`              | wpm-node   | docker-compose.yml | `4000`                 | Yes      |
| `CHAIN_FILE`             | wpm-node   | docker-compose.yml | `/data/chain.jsonl`    | Yes      |
| `SIGNER_KEY_PATH`        | wpm-node   | docker-compose.yml | `/keys/signer.pem`     | Yes      |
| `ORACLE_PUBLIC_KEY_PATH` | wpm-node   | docker-compose.yml | `/keys/oracle.pub`     | Yes      |
| `API_PORT`               | wpm-api    | docker-compose.yml | `3000`                 | Yes      |
| `NODE_URL`               | wpm-api    | docker-compose.yml | `http://wpm-node:4000` | Yes      |
| `JWT_SECRET`             | wpm-api    | `.env` file on VPS | None                   | Yes      |
| `ADMIN_API_KEY`          | wpm-api    | `.env` file on VPS | None                   | Yes      |
| `ORACLE_PORT`            | wpm-oracle | docker-compose.yml | `3001`                 | Yes      |
| `API_URL`                | wpm-oracle | docker-compose.yml | `http://wpm-api:3000`  | Yes      |
| `ORACLE_KEY_PATH`        | wpm-oracle | docker-compose.yml | `/keys/oracle.pem`     | Yes      |
| `ENABLED_SPORTS`         | wpm-oracle | docker-compose.yml | `NFL`                  | Yes      |
| `INGEST_CRON`            | wpm-oracle | docker-compose.yml | `0 6 * * *`            | Yes      |
| `RESOLVE_CRON`           | wpm-oracle | docker-compose.yml | `*/30 12-24 * * *`     | Yes      |
| `LOOKAHEAD_DAYS`         | wpm-oracle | docker-compose.yml | `14`                   | Yes      |
| `DEFAULT_SEED_AMOUNT`    | wpm-oracle | docker-compose.yml | `1000`                 | Yes      |
| `TZ`                     | wpm-oracle | docker-compose.yml | `America/New_York`     | Yes      |
| `DOMAIN`                 | VPS-level  | `.env` file on VPS | None                   | Yes      |

**`.env.example` (committed to repo):**

```bash
# Copy to .env on VPS and fill in values
JWT_SECRET=
ADMIN_API_KEY=
DOMAIN=wpm.example.com
TZ=America/New_York
```

**`.env` (on VPS, NOT committed):**

```bash
JWT_SECRET=<random-64-char-hex-string>
ADMIN_API_KEY=<random-32-char-hex-string>
DOMAIN=wpm.example.com
TZ=America/New_York
```

**Acceptance Criteria:**

- [ ] Given `.env` is missing `JWT_SECRET`, when `wpm-api` starts, then it exits with a clear error message indicating the missing variable.
- [ ] Given `.env.example` is committed to the repo, then it contains no actual secrets -- only placeholder values.
- [ ] Given a service reads an environment variable, then it validates the value at startup and fails fast with a descriptive error if the value is invalid or missing.

### FR-10: Backup Strategy

**Description:** `chain.jsonl` is the sole system-of-record. A daily backup cron job copies it to a local backup directory on the VPS.

**Backup cron (on VPS):**

```bash
# /etc/cron.d/wpm-backup
0 4 * * * deploy docker cp wpm-wpm-node-1:/data/chain.jsonl /opt/wpm-backups/chain-$(date +\%Y\%m\%d).jsonl && find /opt/wpm-backups -name "chain-*.jsonl" -mtime +30 -delete
```

**Behavior:**

- Runs daily at 4:00 AM server time.
- Copies `chain.jsonl` from the running node container.
- Names the backup with a date stamp: `chain-20260306.jsonl`.
- Retains backups for 30 days, then deletes older files.
- Backup directory: `/opt/wpm-backups/` (local directory on the VPS).
- For MVP, local backup is sufficient since the chain file is tiny (kilobytes to low megabytes). Offsite backup (e.g., Cloudflare R2 free tier) can be added later for disaster recovery.

**Recovery procedure:**

1. Stop services: `docker compose down`
2. Copy backup into the volume: `docker cp chain-YYYYMMDD.jsonl wpm-wpm-node-1:/data/chain.jsonl`
3. Start services: `docker compose up -d`
4. Node replays the JSONL file and rebuilds state.

**Acceptance Criteria:**

- [ ] Given the backup cron runs, then a dated copy of `chain.jsonl` appears in `/opt/wpm-backups/`.
- [ ] Given backups older than 30 days exist, then they are deleted by the cron job.
- [ ] Given a backup file is restored and services are started, then the node replays all blocks and reaches a consistent state.

## 4. Non-Functional Requirements

### Performance

| Metric                                       | Target       | Rationale                               |
| -------------------------------------------- | ------------ | --------------------------------------- |
| CI pipeline duration (test + build + deploy) | < 10 minutes | Fast feedback loop for developers       |
| Container startup (all services healthy)     | < 60 seconds | Minimizes downtime window during deploy |
| Nginx request latency overhead               | < 5 ms added | Proxy layer should be transparent       |
| Docker image size (per service)              | < 200 MB     | Faster pulls on deploy                  |

### Reliability

| Metric                         | Target                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Availability                   | Best-effort; no SLA (hobby project). Target: ~99% (< 3.6 days/year downtime). |
| Recovery Time Objective (RTO)  | < 30 minutes (manual SSH + restore from backup)                               |
| Recovery Point Objective (RPO) | < 24 hours (daily backup)                                                     |
| Auto-restart                   | All containers restart on crash via `unless-stopped` policy                   |

### Security

| Concern             | Measure                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| TLS                 | Enforced via Nginx; HTTP 301 redirects to HTTPS                                |
| SSH access          | Ed25519 key-based only; password auth disabled                                 |
| Secrets             | `.env` file on VPS, never committed to repo                                    |
| Key files           | Private keys are `chmod 600`; mounted read-only in containers                  |
| Firewall            | UFW allows only ports 22, 80, 443                                              |
| Container isolation | Services communicate only over the `wpm-net` bridge network; no `--privileged` |
| HSTS                | `Strict-Transport-Security` header with 1-year max-age                         |
| Image provenance    | Images built in CI from the same commit that passed tests                      |
| Security headers    | `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection` |

### Scalability

Not a primary concern. The system is designed for a single VPS serving ~10-50 users. If growth exceeds capacity:

- Vertical scaling: live-resize the Hetzner plan (up to 16 vCPU, 32 GB RAM) with no migration required.
- No horizontal scaling path is planned.

## 5. Developer Workflow

### Local Development

```bash
# Clone and install
git clone <repo> && cd wpm
bun install

# Run all tests
bunx turbo test

# Run a specific service in dev mode
bunx turbo dev --filter=@wpm/api

# Build everything
bunx turbo build

# Build one package and its dependencies
bunx turbo build --filter=@wpm/api

# Type check all packages
bunx turbo typecheck

# Run Docker Compose locally (requires keys + .env)
docker compose up -d
```

### Deployment Flow

```
Developer pushes to main
         |
         v
GitHub Actions: checkout → bun install → turbo test → turbo typecheck
         |
       pass?──no──> Workflow fails, no deploy
         |
        yes
         |
         v
GitHub Actions: docker compose build → docker compose push (to ghcr.io)
         |
         v
GitHub Actions: SSH to VPS → docker compose pull → docker compose up -d --remove-orphans → docker image prune -f
         |
         v
VPS: containers replaced, new version live
```

### Rollback Procedure

1. Identify the last known good commit SHA.
2. Trigger rebuild: `git revert <bad-commit> && git push origin main` -- or manually re-run the workflow for the good commit.
3. Alternative (faster): SSH to VPS and pull specific image tags if they were retained, or rebuild locally and push.

There is no automated rollback. The system relies on the CI pipeline's test gate to prevent bad deploys.

## 6. Monitoring & Observability

### Health Checks

| Endpoint                   | Service  | Checks                                                 | Called By                             |
| -------------------------- | -------- | ------------------------------------------------------ | ------------------------------------- |
| `GET /internal/health`     | wpm-node | Chain loaded, mempool accessible                       | Docker healthcheck, wpm-api           |
| `GET /health`              | wpm-api  | API server up, node reachable                          | Docker healthcheck, Nginx             |
| `GET /admin/system/health` | wpm-api  | Aggregated: node status, oracle last run, chain height | Admin portal, external uptime monitor |

### Logging

- All services log to stdout/stderr (Docker captures these).
- View logs: `docker compose logs -f <service>` or `docker compose logs --tail=100 <service>`.
- No log aggregation system. Logs are retained by Docker's default json-file driver.
- Log rotation: configure Docker daemon with `max-size` and `max-file`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

### External Monitoring

- UptimeRobot (free tier) pinging `https://wpm.example.com/admin/system/health` every 5 minutes.
- Alerts via email or SMS on downtime.

## 7. Error Handling

| Error Scenario                  | Detection                                | Response                                                | Recovery                                                                                                   |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Container crash                 | Docker detects exit                      | Auto-restart via `unless-stopped` policy                | Container restarts; node replays `chain.jsonl`                                                             |
| Node unhealthy during deploy    | Healthcheck fails                        | `wpm-api` does not start (depends_on condition)         | Fix node issue, redeploy                                                                                   |
| VPS disk full                   | Container crashes on write               | Alert via monitoring (health check fails)               | SSH in, prune images/logs, expand disk                                                                     |
| TLS certificate expired         | Nginx refuses connections                | Certbot renewal cron should prevent this                | Manual `certbot renew` + Nginx reload                                                                      |
| SSH deploy fails                | GitHub Actions step fails                | Workflow reports failure; VPS keeps running old version | Re-run workflow or SSH manually                                                                            |
| ghcr.io unavailable             | `docker compose push` fails              | Workflow fails; no deploy                               | Wait and re-run                                                                                            |
| DNS not resolving               | Users cannot reach the site              | External monitoring alerts                              | Check registrar, fix A record                                                                              |
| Key volume accidentally deleted | Node fails to start (missing signer key) | Cannot produce blocks                                   | Restore keys from secure backup; if no backup, system must be re-initialized (new genesis, all state lost) |
| `chain.jsonl` corruption        | Node fails on replay                     | Node does not start                                     | Restore from backup                                                                                        |
| Concurrent deploys              | Race condition on container replacement  | `concurrency` group in GitHub Actions prevents this     | Pipeline queues the second deploy                                                                          |

### Critical Warning: Key Loss

If the `keys` volume is destroyed and no backup of the key files exists, the system cannot be recovered. A new genesis block must be created, and all chain history is lost. Key files should be backed up to a secure offline location immediately after initial generation.

## 8. Project File Structure

```
wpm/
├── package.json                  # Root -- Bun workspaces
├── turbo.json                    # Turborepo task pipeline
├── tsconfig.json                 # Base TypeScript config (extended by packages)
├── docker-compose.yml            # All service definitions
├── .env.example                  # Template for VPS .env file
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
│   └── web/                      # @wpm/web (React + Vite + vite-plugin-pwa + Tailwind CSS)
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

## 9. Validation & Acceptance Criteria

### Critical Path Tests

These scenarios must all pass for the infrastructure to be considered functional:

| #   | Scenario                                         | Expected Outcome                                   |
| --- | ------------------------------------------------ | -------------------------------------------------- |
| 1   | `bun install` at repo root                       | All workspace symlinks created, no errors          |
| 2   | `bunx turbo build`                               | All packages build in correct order (shared first) |
| 3   | `bunx turbo test`                                | All tests pass                                     |
| 4   | `docker compose build`                           | All four custom images build successfully          |
| 5   | `docker compose up -d` (on VPS with keys + .env) | All five containers reach `running` status         |
| 6   | `curl -k https://localhost/api/health` (on VPS)  | Returns 200 from wpm-api                           |
| 7   | `curl -k https://localhost/` (on VPS)            | Returns SPA HTML from wpm-web                      |
| 8   | SSE connection to `/events/`                     | Connection stays open, receives events             |
| 9   | `docker compose down && docker compose up -d`    | `chain.jsonl` persists, node replays successfully  |
| 10  | Push to `main` with passing tests                | Full CI/CD pipeline runs, VPS updated              |
| 11  | Push to `main` with failing tests                | Pipeline stops at test stage, no deploy            |
| 12  | `init-keys.sh` on fresh volume                   | Four key files created with correct permissions    |
| 13  | `init-keys.sh` when keys exist                   | Script aborts, existing keys untouched             |

### Integration Checkpoints

- [ ] `wpm-api` can reach `wpm-node` at `http://wpm-node:4000/internal/health` over `wpm-net`.
- [ ] `wpm-oracle` can reach `wpm-api` at `http://wpm-api:3000` over `wpm-net`.
- [ ] Nginx can reach both `wpm-api:3000` and `wpm-web:80` over `wpm-net`.
- [ ] GitHub Actions can SSH to the VPS and run `docker compose` commands.
- [ ] GitHub Actions can push images to `ghcr.io`.
- [ ] VPS can pull images from `ghcr.io`.

## 10. Resolved Questions

| #   | Question                                                                    | Resolution                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should key files be backed up to an off-server location?                    | Yes, recommended. For MVP, keys are on the VPS only. Offsite backup (e.g., encrypted in a password manager) should be done manually after initial generation.                           |
| 2   | Should the CI pipeline run on PRs for pre-merge testing?                    | Yes. Add a separate `test-only` workflow triggered on `pull_request` events. Not blocking for MVP.                                                                                      |
| 3   | Should images be tagged with commit SHA in addition to `latest`?            | No. `latest` is sufficient for current scale. Rollback by reverting the commit and re-deploying.                                                                                        |
| 4   | Should `chain.jsonl` backups be shipped off-server?                         | Not for MVP. Local backups to `/opt/wpm-backups/` are sufficient given the chain file is tiny. Offsite backup (e.g., Cloudflare R2 free tier) can be added later for disaster recovery. |
| 5   | Should Docker log rotation be configured in `daemon.json` or per-container? | `daemon.json` -- apply globally. Configuration is specified in section 6 (Logging).                                                                                                     |

## Appendix

### Glossary

| Term          | Definition                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------- |
| **ghcr.io**   | GitHub Container Registry -- Docker image hosting provided by GitHub                              |
| **PoA**       | Proof of Authority -- consensus mechanism using a single trusted signer                           |
| **JSONL**     | JSON Lines -- one JSON object per line, used for the append-only chain file                       |
| **SSE**       | Server-Sent Events -- HTTP-based unidirectional streaming protocol                                |
| **Turborepo** | Build system for JavaScript/TypeScript monorepos with dependency-aware task execution and caching |
| **certbot**   | Let's Encrypt client for obtaining and renewing TLS certificates                                  |
| **UFW**       | Uncomplicated Firewall -- iptables frontend on Ubuntu                                             |

### References

- [ARCHITECTURE.md](/ARCHITECTURE.md) -- System-wide architecture document
- [blockchain-node.md](/specs/blockchain-node.md) -- Blockchain node component spec
- [api-server.md](/specs/api-server.md) -- API server component spec
- [oracle-server.md](/specs/oracle-server.md) -- Oracle server component spec
- [web-app.md](/specs/web-app.md) -- Web app component spec
