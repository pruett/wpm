FROM node:22-slim AS build
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g bun
WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
RUN bun install

COPY packages/shared packages/shared
COPY packages/web packages/web
# Build with Node.js — better-sqlite3 is unsupported in bun runtime
RUN cd packages/shared && node_modules/.bin/tsc && \
    cd ../web && node_modules/.bin/vite build

# Install production deps with native modules compiled for Alpine
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY --from=build /app/packages/web/package.json ./
# Strip workspace dep (bundled by Vite, not needed at runtime)
RUN node -e "\
  const p = JSON.parse(require('fs').readFileSync('package.json','utf8'));\
  delete p.dependencies['@wpm/shared'];\
  require('fs').writeFileSync('package.json', JSON.stringify(p));"
RUN npm install --omit=dev

# --- Runtime ---
FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/packages/web/build build
COPY --from=build /app/packages/web/package.json .
USER node
EXPOSE 4102
CMD ["node", "build"]
