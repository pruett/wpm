FROM oven/bun:1-alpine AS bun

# --- Builder ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx

COPY package.json turbo.json tsconfig.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN bun install

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN bunx turbo build --filter=@wpm/web

# Bundle the DB bootstrap script into a single JS file (all deps inlined except
# the better-sqlite3 native addon, which is resolved from standalone's node_modules).
RUN cd apps/web && bun build src/lib/db/bootstrap.ts \
    --target=node \
    --outfile=dist-bootstrap.js \
    --external=better-sqlite3

# --- Runtime ---
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
# `outputFileTracingIncludes` in next.config.ts copies the migrations folder
# into standalone output at this path.
ENV WPM_MIGRATIONS_DIR=/app/apps/web/src/lib/db/migrations

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/dist-bootstrap.js ./apps/web/dist-bootstrap.js

USER nextjs

EXPOSE 4102
ENV PORT=4102
ENV HOSTNAME=0.0.0.0

CMD ["sh", "-c", "node apps/web/dist-bootstrap.js && node apps/web/server.js"]
