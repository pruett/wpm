FROM oven/bun:1 AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/node/package.json packages/node/
COPY packages/api/package.json packages/api/
COPY packages/oracle/package.json packages/oracle/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN bunx turbo build --filter=@wpm/web

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/web/build build/
COPY --from=builder /app/packages/web/package.json .
COPY --from=builder /app/node_modules node_modules/
ENV PORT=4102
EXPOSE 4102
CMD ["node", "build"]
