import { Context, Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { Transaction, Market, AMMPool, NodeEvent } from "@wpm/shared";
import { NodeClientError } from "./errors.js";

export class NodeClient extends Context.Tag("NodeClient")<
  NodeClient,
  {
    readonly submitTransaction: (tx: Transaction) => Effect.Effect<void, NodeClientError>;
    readonly distribute: (
      recipient: string,
      amount: number,
      reason: string,
    ) => Effect.Effect<void, NodeClientError>;
    readonly getMarkets: Effect.Effect<Array<{ market: Market; pool: AMMPool }>, NodeClientError>;
    readonly getMarket: (
      id: string,
    ) => Effect.Effect<{ market: Market; pool: AMMPool } | null, NodeClientError>;
    readonly getBalance: (address: string) => Effect.Effect<number, NodeClientError>;
    readonly health: Effect.Effect<boolean>;
    readonly eventStream: Effect.Effect<Stream.Stream<NodeEvent>, NodeClientError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const client = baseClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost:4100")),
      );
      return {
        submitTransaction: (tx) =>
          HttpClientRequest.post("/internal/transaction").pipe(
            HttpClientRequest.bodyUnsafeJson(tx),
            client.execute,
            Effect.asVoid,
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ),
        distribute: (recipient, amount, reason) =>
          HttpClientRequest.post("/internal/distribute").pipe(
            HttpClientRequest.bodyUnsafeJson({ recipient, amount, reason }),
            client.execute,
            Effect.asVoid,
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ),
        getMarkets: client.get("/internal/markets").pipe(
          Effect.flatMap((res) => res.json),
          Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
          Effect.scoped,
        ) as Effect.Effect<Array<{ market: Market; pool: AMMPool }>, NodeClientError>,
        getMarket: (id) =>
          client.get(`/internal/market/${id}`).pipe(
            Effect.flatMap((res) => res.json),
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ) as Effect.Effect<{ market: Market; pool: AMMPool } | null, NodeClientError>,
        getBalance: (address) =>
          client.get(`/internal/balance/${address}`).pipe(
            Effect.flatMap((res) => res.json),
            Effect.map((body: any) => body.balance as number),
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ),
        health: client.get("/internal/health").pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
          Effect.scoped,
        ),
        eventStream: Effect.succeed(Stream.empty),
      };
    }),
  );
}
