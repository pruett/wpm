import { Context, Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import {
  NODE_INTERNAL_URL,
  type Block,
  type Transaction,
  type Market,
  type AMMPool,
  type NodeEvent,
  type SharePosition,
} from "@wpm/shared";
import { NodeClientError } from "./errors.js";

function parseSSE(chunk: string): NodeEvent[] {
  const events: NodeEvent[] = [];
  for (const block of chunk.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine) {
      try {
        events.push(JSON.parse(dataLine.slice(6)));
      } catch {
        // skip malformed
      }
    }
  }
  return events;
}

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
    readonly getPositions: (address: string) => Effect.Effect<SharePosition[], NodeClientError>;
    readonly getPositionsByMarket: (
      marketId: string,
    ) => Effect.Effect<SharePosition[], NodeClientError>;
    readonly getAllPositions: Effect.Effect<SharePosition[], NodeClientError>;
    readonly getAllBalances: Effect.Effect<
      Array<{ address: string; balance: number }>,
      NodeClientError
    >;
    readonly getBlocks: Effect.Effect<Block[], NodeClientError>;
    readonly health: Effect.Effect<boolean>;
    readonly eventStream: Effect.Effect<Stream.Stream<NodeEvent>, NodeClientError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const client = baseClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(NODE_INTERNAL_URL)),
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
        getPositions: (address) =>
          client.get(`/internal/positions/${address}`).pipe(
            Effect.flatMap((res) => res.json),
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ) as Effect.Effect<SharePosition[], NodeClientError>,
        getPositionsByMarket: (marketId) =>
          client.get(`/internal/positions/market/${marketId}`).pipe(
            Effect.flatMap((res) => res.json),
            Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
            Effect.scoped,
          ) as Effect.Effect<SharePosition[], NodeClientError>,
        getAllPositions: client.get("/internal/positions").pipe(
          Effect.flatMap((res) => res.json),
          Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
          Effect.scoped,
        ) as Effect.Effect<SharePosition[], NodeClientError>,
        getAllBalances: client.get("/internal/balances").pipe(
          Effect.flatMap((res) => res.json),
          Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
          Effect.scoped,
        ) as Effect.Effect<Array<{ address: string; balance: number }>, NodeClientError>,
        getBlocks: client.get("/internal/blocks").pipe(
          Effect.flatMap((res) => res.json),
          Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
          Effect.scoped,
        ) as Effect.Effect<Block[], NodeClientError>,
        health: client.get("/internal/health").pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
          Effect.scoped,
        ),
        eventStream: client.get("/internal/events").pipe(
          Effect.map((res) => {
            const decoder = new TextDecoder();
            return res.stream.pipe(
              Stream.mapConcat((chunk) => parseSSE(decoder.decode(chunk, { stream: true }))),
              Stream.catchAll(() => Stream.empty),
            );
          }),
          Effect.mapError((e) => new NodeClientError({ message: `${e}` })),
        ),
      };
    }),
  );
}
