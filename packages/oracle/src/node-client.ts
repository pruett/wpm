import { Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NODE_INTERNAL_URL, type Market, type AMMPool } from "@wpm/shared";
import { OracleError } from "./errors.js";

export type CreateMarketParams = {
  readonly id: string;
  readonly name: string;
  readonly outcomes: [string, string];
  readonly closesAt: string;
  readonly seedAmount: number;
  readonly initialProbabilityA?: number;
};

export class NodeClient extends Context.Tag("oracle/NodeClient")<
  NodeClient,
  {
    readonly getMarkets: Effect.Effect<Array<{ market: Market; pool: AMMPool }>, OracleError>;
    readonly createMarket: (params: CreateMarketParams) => Effect.Effect<void, OracleError>;
    readonly health: Effect.Effect<boolean>;
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
        getMarkets: client.get("/internal/markets").pipe(
          Effect.flatMap((res) => res.json),
          Effect.mapError((e) => new OracleError({ message: `Failed to fetch markets: ${e}` })),
          Effect.scoped,
        ) as Effect.Effect<Array<{ market: Market; pool: AMMPool }>, OracleError>,

        createMarket: (params) =>
          HttpClientRequest.post("/internal/create-market").pipe(
            HttpClientRequest.bodyUnsafeJson(params),
            client.execute,
            Effect.asVoid,
            Effect.mapError((e) => new OracleError({ message: `Failed to create market: ${e}` })),
            Effect.scoped,
          ),

        health: client.get("/internal/health").pipe(
          Effect.as(true),
          Effect.catchAll(() => Effect.succeed(false)),
          Effect.scoped,
        ),
      };
    }),
  );
}
