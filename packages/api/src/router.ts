import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import { calculatePrices, sign, serializeTx } from "@wpm/shared";
import type { MarketWithOdds, PriceUpdateEvent } from "@wpm/shared";
import { NodeClient } from "./node-client.js";
import { UserKeys } from "./user-keys.js";

const BetBody = Schema.Struct({
  marketId: Schema.String,
  outcome: Schema.Union(Schema.Literal("A"), Schema.Literal("B")),
  amount: Schema.Number,
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
          const { priceA, priceB } = calculatePrices(pool);
          return {
            ...market,
            priceA,
            priceB,
            multiplierA: 1 / priceA,
            multiplierB: 1 / priceB,
            pool,
          };
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

    HttpRouter.get(
      "/events/stream",
      Effect.gen(function* () {
        const stream = yield* nodeClient.eventStream;
        const transformed = stream.pipe(
          Stream.map((event) => {
            const { priceA, priceB } = calculatePrices(event.pool);
            const update: PriceUpdateEvent = {
              type: "price:update",
              marketId: event.marketId,
              priceA,
              priceB,
              multiplierA: 1 / priceA,
              multiplierB: 1 / priceB,
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
