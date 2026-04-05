FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/oracle/package.json packages/oracle/
RUN bun install --ignore-scripts

COPY packages/shared packages/shared
COPY packages/oracle packages/oracle
RUN bunx turbo build --filter=@wpm/oracle

# --- Runtime ---
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/src packages/shared/src
COPY --from=build /app/packages/oracle/package.json packages/oracle/package.json
COPY --from=build /app/packages/oracle/dist packages/oracle/dist
RUN bun install --production --ignore-scripts
WORKDIR /app/packages/oracle
CMD ["bun", "run", "dist/index.js"]
