import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import { calculateOdds, sign, serializeTx } from "@wpm/shared";
import type { MarketWithOdds, PriceUpdateEvent } from "@wpm/shared";
import { NodeClient } from "./node-client.js";
import { UserKeys } from "./user-keys.js";

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

export const makeRouter = Effect.gen(function* () {
  const nodeClient = yield* NodeClient;
  const userKeys = yield* UserKeys;

  return HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/markets",
      Effect.gen(function* () {
        const raw = yield* nodeClient.getMarkets;
        const enriched: MarketWithOdds[] = raw.map(({ market, pool }) => {
          if (market.status === "resolved") {
            const winA = market.result === "A" ? 1.0 : 0.0;
            const winB = market.result === "B" ? 1.0 : 0.0;
            return {
              ...market,
              priceA: winA,
              priceB: winB,
              multiplierA: winA > 0 ? 1 / winA : 0,
              multiplierB: winB > 0 ? 1 / winB : 0,
              pool,
            };
          }
          const odds = calculateOdds(pool);
          return { ...market, ...odds, pool };
        });
        return yield* HttpServerResponse.json(enriched);
      }),
    ),

    HttpRouter.post(
      "/api/bet",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(BetBody);
        const tx = {
          type: "PlaceBet" as const,
          marketId: body.marketId,
          outcome: body.outcome,
          amount: body.amount,
          submitter: userKeys.publicKey,
          timestamp: new Date().toISOString(),
          signature: "",
        };
        tx.signature = sign(serializeTx(tx as Record<string, unknown>), userKeys.privateKey);
        yield* nodeClient.submitTransaction(tx);
        return yield* HttpServerResponse.json({ success: true });
      }).pipe(
        Effect.catchTag("NodeClientError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: 502 }),
        ),
      ),
    ),

    HttpRouter.post(
      "/api/sell",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(SellBody);
        const tx = {
          type: "SellShares" as const,
          marketId: body.marketId,
          outcome: body.outcome,
          shares: body.shares,
          submitter: userKeys.publicKey,
          timestamp: new Date().toISOString(),
          signature: "",
        };
        tx.signature = sign(serializeTx(tx as Record<string, unknown>), userKeys.privateKey);
        yield* nodeClient.submitTransaction(tx);
        return yield* HttpServerResponse.json({ success: true });
      }).pipe(
        Effect.catchTag("NodeClientError", (e) =>
          HttpServerResponse.json({ error: e.message }, { status: 502 }),
        ),
      ),
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
});
