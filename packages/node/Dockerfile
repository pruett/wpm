FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/node/package.json packages/node/
RUN bun install --ignore-scripts

COPY packages/shared packages/shared
COPY packages/node packages/node
RUN bunx turbo build --filter=@wpm/node

# --- Runtime ---
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/bun.lock ./
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/src packages/shared/src
COPY --from=build /app/packages/node/package.json packages/node/package.json
COPY --from=build /app/packages/node/dist packages/node/dist
RUN bun install --production --ignore-scripts
WORKDIR /app/packages/node
EXPOSE 4000
CMD ["sh", "-c", "bun run dist/setup.js && exec bun run dist/index.js"]
