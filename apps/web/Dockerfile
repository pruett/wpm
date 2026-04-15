FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/

RUN sed -i 's/"workspace:\*"/"*"/g' apps/web/package.json && npm install

RUN rm -rf packages/*/node_modules apps/*/node_modules
COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npx turbo build --filter=@wpm/web-next

# --- Runtime ---
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs

EXPOSE 4102
ENV PORT=4102
ENV HOSTNAME=0.0.0.0

CMD ["node", "apps/web/server.js"]
