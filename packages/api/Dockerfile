FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/node/package.json packages/node/
COPY packages/api/package.json packages/api/
COPY packages/oracle/package.json packages/oracle/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN bunx turbo build --filter=@wpm/api

FROM oven/bun:1
WORKDIR /app
COPY --from=builder /app/packages/api/dist ./dist
COPY --from=builder /app/packages/api/package.json ./
EXPOSE 3000
CMD ["bun", "run", "dist/index.js"]
