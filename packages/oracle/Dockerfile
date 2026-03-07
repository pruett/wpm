FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/oracle/package.json packages/oracle/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/oracle packages/oracle
RUN bunx turbo build --filter=@wpm/oracle

FROM oven/bun:1
WORKDIR /app
COPY --from=builder /app/packages/oracle/dist ./dist
COPY --from=builder /app/packages/oracle/package.json ./
CMD ["bun", "run", "dist/index.js"]
