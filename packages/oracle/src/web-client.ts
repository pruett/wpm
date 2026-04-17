import { Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import {
  WEB_INTERNAL_URL,
  type CreateMarketRequest,
  type HeartbeatRequest,
  type OracleMarket,
} from "@wpm/shared";
import { OracleError } from "./errors.js";

const ORACLE_TOKEN = process.env.WPM_ORACLE_SERVICE_TOKEN ?? "";

export class WebClient extends Context.Tag("oracle/WebClient")<
  WebClient,
  {
    readonly health: Effect.Effect<boolean>;
    readonly getMarkets: Effect.Effect<OracleMarket[], OracleError>;
    readonly createMarket: (
      params: CreateMarketRequest,
    ) => Effect.Effect<{ created: boolean }, OracleError>;
    readonly resolveMarket: (
      marketId: string,
      outcome: "A" | "B",
    ) => Effect.Effect<void, OracleError>;
    readonly cancelMarket: (marketId: string, reason?: string) => Effect.Effect<void, OracleError>;
    readonly heartbeat: (params: HeartbeatRequest) => Effect.Effect<void, OracleError>;
  }
>() {
  static Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const baseClient = yield* HttpClient.HttpClient;
      const client = baseClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(WEB_INTERNAL_URL)),
        HttpClient.mapRequest(
          HttpClientRequest.setHeader("Authorization", `Bearer ${ORACLE_TOKEN}`),
        ),
      );

      return {
        health: client.get("/api/oracle/health").pipe(
          Effect.flatMap((res) =>
            res.status >= 200 && res.status < 300
              ? Effect.succeed(true)
              : Effect.fail(`health check returned ${res.status}`),
          ),
          Effect.catchAll(() => Effect.succeed(false)),
          Effect.scoped,
        ),

        getMarkets: client.get("/api/oracle/markets").pipe(
          Effect.flatMap((res) => res.json),
          Effect.mapError((e) => new OracleError({ message: `Failed to fetch markets: ${e}` })),
          Effect.scoped,
        ) as Effect.Effect<OracleMarket[], OracleError>,

        createMarket: (params) =>
          HttpClientRequest.post("/api/oracle/markets").pipe(
            HttpClientRequest.bodyUnsafeJson(params),
            client.execute,
            Effect.flatMap((res) => res.json),
            Effect.mapError((e) => new OracleError({ message: `Failed to create market: ${e}` })),
            Effect.scoped,
          ) as Effect.Effect<{ created: boolean }, OracleError>,

        resolveMarket: (marketId, outcome) =>
          HttpClientRequest.post(`/api/oracle/markets/${marketId}/resolve`).pipe(
            HttpClientRequest.bodyUnsafeJson({ outcome }),
            client.execute,
            Effect.asVoid,
            Effect.mapError(
              (e) => new OracleError({ message: `Failed to resolve market ${marketId}: ${e}` }),
            ),
            Effect.scoped,
          ),

        cancelMarket: (marketId, reason) =>
          HttpClientRequest.post(`/api/oracle/markets/${marketId}/cancel`).pipe(
            HttpClientRequest.bodyUnsafeJson({ reason }),
            client.execute,
            Effect.asVoid,
            Effect.mapError(
              (e) => new OracleError({ message: `Failed to cancel market ${marketId}: ${e}` }),
            ),
            Effect.scoped,
          ),

        heartbeat: (params) =>
          HttpClientRequest.post("/api/oracle/heartbeat").pipe(
            HttpClientRequest.bodyUnsafeJson(params),
            client.execute,
            Effect.asVoid,
            Effect.mapError((e) => new OracleError({ message: `Failed to post heartbeat: ${e}` })),
            Effect.scoped,
          ),
      };
    }),
  );
}
