import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Schema, Stream } from "effect";
import type { Transaction } from "@wpm/shared";
import { sign, serializeTx } from "@wpm/shared";
import { ChainState } from "./chain-state.js";
import { Mempool } from "./mempool.js";
import { Keys } from "./keys.js";
import { EventBus } from "./event-bus.js";

const AddressParams = Schema.Struct({ address: Schema.String });
const IdParams = Schema.Struct({ id: Schema.String });
const DistributeBody = Schema.Struct({
  recipient: Schema.String,
  amount: Schema.Number,
  reason: Schema.String,
});
const CreateMarketBody = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  outcomes: Schema.Tuple(Schema.String, Schema.String),
  closesAt: Schema.String,
  seedAmount: Schema.Number,
});

function makeSystemTx(
  fields: Record<string, unknown>,
  poaKeys: { poaPublicKey: string; poaPrivateKey: string },
): Transaction {
  const tx = { ...fields, timestamp: new Date().toISOString(), signature: "" };
  tx.signature = sign(serializeTx(tx), poaKeys.poaPrivateKey);
  return tx as Transaction;
}

export const makeRouter = Effect.gen(function* () {
  const chainState = yield* ChainState;
  const mempool = yield* Mempool;
  const keys = yield* Keys;
  const eventBus = yield* EventBus;

  return HttpRouter.empty.pipe(
    HttpRouter.get("/internal/health", HttpServerResponse.json({ status: "ok" })),

    HttpRouter.get(
      "/internal/balance/:address",
      Effect.gen(function* () {
        const { address } = yield* HttpRouter.schemaPathParams(AddressParams);
        const balance = yield* chainState.getBalance(address);
        return yield* HttpServerResponse.json({ address, balance });
      }),
    ),

    HttpRouter.get(
      "/internal/markets",
      Effect.gen(function* () {
        const markets = yield* chainState.getMarkets;
        return yield* HttpServerResponse.json(markets);
      }),
    ),

    HttpRouter.get(
      "/internal/market/:id",
      Effect.gen(function* () {
        const { id } = yield* HttpRouter.schemaPathParams(IdParams);
        const market = yield* chainState.getMarket(id);
        if (!market) return yield* HttpServerResponse.json({ error: "Not found" }, { status: 404 });
        const pool = yield* chainState.getPool(id);
        return yield* HttpServerResponse.json({ market, pool });
      }),
    ),

    HttpRouter.get(
      "/internal/positions/:address",
      Effect.gen(function* () {
        const { address } = yield* HttpRouter.schemaPathParams(AddressParams);
        const positions = yield* chainState.getPositions(address);
        return yield* HttpServerResponse.json(positions);
      }),
    ),

    HttpRouter.post(
      "/internal/transaction",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(Schema.Any);
        yield* mempool.add(body as Transaction);
        return yield* HttpServerResponse.json({ accepted: true });
      }).pipe(
        Effect.catchTag("ValidationError", (e) =>
          HttpServerResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 }),
        ),
      ),
    ),

    HttpRouter.post(
      "/internal/distribute",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(DistributeBody);
        const tx = makeSystemTx(
          { type: "Distribute", to: body.recipient, amount: body.amount, memo: body.reason },
          keys,
        );
        yield* mempool.add(tx);
        return yield* HttpServerResponse.json({ accepted: true });
      }),
    ),

    HttpRouter.post(
      "/internal/create-market",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CreateMarketBody);
        const tx = makeSystemTx(
          {
            type: "CreateMarket",
            id: body.id,
            name: body.name,
            outcomes: body.outcomes,
            closesAt: body.closesAt,
            seedAmount: body.seedAmount,
          },
          keys,
        );
        yield* mempool.add(tx);
        return yield* HttpServerResponse.json({ accepted: true });
      }).pipe(
        Effect.catchTag("ValidationError", (e) =>
          HttpServerResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 }),
        ),
      ),
    ),

    HttpRouter.get(
      "/internal/events",
      Effect.gen(function* () {
        const stream = yield* eventBus.subscribe;
        const sseStream = stream.pipe(
          Stream.map((event) =>
            new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          ),
        );
        return HttpServerResponse.stream(sseStream, {
          contentType: "text/event-stream",
          headers: { "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }),
    ),
  );
});
