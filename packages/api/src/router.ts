import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import { calculateOdds, sign, serializeTx, SIGNUP_AIRDROP } from "@wpm/shared";
import type {
  Block,
  LeaderboardEntry,
  MarketWithOdds,
  PriceUpdateEvent,
  SharePosition,
} from "@wpm/shared";
import { NodeClient } from "./node-client.js";
import { UserStore } from "./user-store.js";
import { authenticated, catchErrors } from "./auth.js";
import { makeCatalogRoutes } from "./catalog-routes.js";

const BetBody = Schema.Struct({
  marketId: Schema.String,
  outcome: Schema.Union(Schema.Literal("A"), Schema.Literal("B")),
  amount: Schema.Number,
});

const SellBody = Schema.Struct({
  marketId: Schema.String,
  outcome: Schema.Union(Schema.Literal("A"), Schema.Literal("B")),
  shares: Schema.Number,
});

const RegisterBody = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
});

export const makeRouter = Effect.gen(function* () {
  const nodeClient = yield* NodeClient;
  const userStore = yield* UserStore;
  const catalogRoutes = yield* makeCatalogRoutes;

  const coreRoutes = HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/health",
      Effect.gen(function* () {
        const nodeOk = yield* nodeClient.health;
        return yield* HttpServerResponse.json(
          {
            status: nodeOk ? "ok" : "degraded",
            node: nodeOk,
          },
          { status: nodeOk ? 200 : 503 },
        );
      }),
    ),

    HttpRouter.get(
      "/api/blocks",
      Effect.gen(function* () {
        const blocks: Block[] = yield* nodeClient.getBlocks;
        return yield* HttpServerResponse.json(blocks);
      }).pipe(catchErrors),
    ),

    HttpRouter.post(
      "/api/register",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(RegisterBody);
        const existing = userStore.getByEmail(body.email);
        if (existing) {
          const balance = yield* nodeClient.getBalance(existing.address);
          return yield* HttpServerResponse.json({
            token: existing.token,
            address: existing.address,
            balance,
          });
        }
        const user = userStore.register(body.name, body.email);
        yield* nodeClient.distribute(user.publicKey, SIGNUP_AIRDROP, "signup_airdrop");
        const balance = yield* nodeClient.getBalance(user.address);
        return yield* HttpServerResponse.json({
          token: user.token,
          address: user.address,
          balance,
        });
      }).pipe(catchErrors),
    ),

    HttpRouter.get(
      "/api/leaderboard",
      Effect.gen(function* () {
        const allBalances = yield* nodeClient.getAllBalances;
        const entries: LeaderboardEntry[] = allBalances
          .map(({ address, balance }) => {
            const user = userStore.getByAddress(address);
            if (!user) return null;
            return { name: user.name, address, balance };
          })
          .filter((e): e is LeaderboardEntry => e !== null)
          .sort((a, b) => b.balance - a.balance);
        return yield* HttpServerResponse.json(entries);
      }).pipe(catchErrors),
    ),

    HttpRouter.get(
      "/api/balance",
      Effect.gen(function* () {
        const user = yield* authenticated;
        const balance = yield* nodeClient.getBalance(user.address);
        return yield* HttpServerResponse.json({ balance, address: user.address });
      }).pipe(catchErrors),
    ),

    HttpRouter.get(
      "/api/positions",
      Effect.gen(function* () {
        const user = yield* authenticated;
        const positions: SharePosition[] = yield* nodeClient.getPositions(user.address);
        return yield* HttpServerResponse.json(positions);
      }).pipe(catchErrors),
    ),

    HttpRouter.post(
      "/api/bet",
      Effect.gen(function* () {
        const user = yield* authenticated;
        const body = yield* HttpServerRequest.schemaBodyJson(BetBody);
        const tx = {
          type: "PlaceBet" as const,
          marketId: body.marketId,
          outcome: body.outcome,
          amount: body.amount,
          submitter: user.publicKey,
          timestamp: new Date().toISOString(),
          signature: "",
        };
        tx.signature = sign(serializeTx(tx as Record<string, unknown>), user.privateKey);
        yield* nodeClient.submitTransaction(tx);
        return yield* HttpServerResponse.json({ success: true });
      }).pipe(catchErrors),
    ),

    HttpRouter.post(
      "/api/sell",
      Effect.gen(function* () {
        const user = yield* authenticated;
        const body = yield* HttpServerRequest.schemaBodyJson(SellBody);
        const tx = {
          type: "SellShares" as const,
          marketId: body.marketId,
          outcome: body.outcome,
          shares: body.shares,
          submitter: user.publicKey,
          timestamp: new Date().toISOString(),
          signature: "",
        };
        tx.signature = sign(serializeTx(tx as Record<string, unknown>), user.privateKey);
        yield* nodeClient.submitTransaction(tx);
        return yield* HttpServerResponse.json({ success: true });
      }).pipe(catchErrors),
    ),

    HttpRouter.get(
      "/events/stream",
      Effect.gen(function* () {
        const stream = yield* nodeClient.eventStream;
        const transformed = stream.pipe(
          Stream.map((event) => {
            if (event.type === "market:resolved") {
              return new TextEncoder().encode(
                `event: market:resolved\ndata: ${JSON.stringify(event)}\n\n`,
              );
            }
            if (event.type === "balance:update") {
              return new TextEncoder().encode(
                `event: balance:update\ndata: ${JSON.stringify(event)}\n\n`,
              );
            }
            const odds = calculateOdds(event.pool);
            const update: PriceUpdateEvent = {
              type: "price:update",
              marketId: event.marketId,
              ...odds,
            };
            return new TextEncoder().encode(
              `event: price:update\ndata: ${JSON.stringify(update)}\n\n`,
            );
          }),
        );
        return HttpServerResponse.stream(transformed, {
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }),
    ),
  );

  return HttpRouter.concat(coreRoutes, catalogRoutes);
});
