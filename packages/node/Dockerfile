FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/node/package.json packages/node/
RUN bun install --ignore-scripts

COPY packages/shared packages/shared
COPY packages/node packages/node
RUN bunx turbo build --filter=@wpm/node

# Prune to production dependencies
RUN rm -rf node_modules && bun install --production --ignore-scripts

# --- Runtime ---
FROM oven/bun:1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/src packages/shared/src
COPY --from=build /app/packages/node/package.json packages/node/package.json
COPY --from=build /app/packages/node/dist packages/node/dist

# Ensure workspace symlink resolves @wpm/shared
RUN rm -rf node_modules/@wpm && mkdir -p node_modules/@wpm && \
    ln -s ../../packages/shared node_modules/@wpm/shared

WORKDIR /app/packages/node
USER bun
EXPOSE 4000
CMD ["bun", "run", "dist/index.js"]
