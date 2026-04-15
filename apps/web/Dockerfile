FROM oven/bun:1-alpine AS bun

# --- Builder ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx
RUN apk add --no-cache python3 make g++

COPY package.json turbo.json tsconfig.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN bun install

COPY packages/shared packages/shared
COPY apps/web apps/web

RUN bunx turbo build --filter=@wpm/web

# --- Runtime ---
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

RUN mkdir -p data && chown nextjs:nodejs data

USER nextjs

EXPOSE 4102
ENV PORT=4102
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
