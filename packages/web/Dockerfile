FROM node:22-slim AS build
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
# Replace bun workspace protocol with npm-compatible syntax
RUN sed -i 's/"workspace:\*"/"*"/g' packages/*/package.json && npm install

# Remove package-level node_modules (npm workspace artifacts) before copying source
RUN rm -rf packages/*/node_modules
COPY packages/shared packages/shared
COPY packages/web packages/web
RUN mkdir -p packages/web/data && \
    ./node_modules/.bin/tsc -p packages/shared/tsconfig.json && \
    cd packages/web && ../../node_modules/.bin/vite build

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
COPY --from=build /app/packages/web/migrations migrations
COPY --from=build /app/packages/web/entrypoint.js .
RUN mkdir -p data
EXPOSE 4102
CMD ["node", "entrypoint.js"]
