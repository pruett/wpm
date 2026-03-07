FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/node/package.json packages/node/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/node packages/node
RUN bunx turbo build --filter=@wpm/node

FROM oven/bun:1
WORKDIR /app
COPY --from=builder /app/packages/node/dist ./dist
COPY --from=builder /app/packages/node/package.json ./
EXPOSE 4000
CMD ["bun", "run", "dist/index.js"]
