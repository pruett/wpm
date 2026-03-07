FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN bunx turbo build --filter=@wpm/web

FROM nginx:alpine
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
