import { Layer } from "effect"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform"
import { WpmApi } from "./Api"
import { AppConfigService } from "./Config"

import { AuthHandlersLive } from "./handlers/AuthHandlers"
import { TradingHandlersLive } from "./handlers/TradingHandlers"
import { MarketsHandlersLive } from "./handlers/MarketsHandlers"
import { WalletHandlersLive } from "./handlers/WalletHandlers"
import { UserHandlersLive } from "./handlers/UserHandlers"
import { LeaderboardHandlersLive } from "./handlers/LeaderboardHandlers"
import { AdminHandlersLive } from "./handlers/AdminHandlers"
import { OracleHandlersLive } from "./handlers/OracleHandlers"
import { EventsHandlersLive } from "./handlers/EventsHandlers"

import { DatabaseLive } from "./layers/DatabaseLayer"
import { DatabaseService } from "./services/DatabaseService"
import { NodeClientService } from "./services/NodeClient"
import { AuthService } from "./services/AuthService"
import { WalletService } from "./services/WalletService"
import { SseRelayService } from "./services/SseRelay"
import { RateLimiterService } from "./services/RateLimiter"

import { AuthMiddlewareLive } from "./middleware/AuthMiddleware"
import { AdminMiddlewareLive } from "./middleware/AdminMiddleware"

// Infrastructure
const ConfigAndDbLive = DatabaseLive.pipe(
  Layer.provideMerge(AppConfigService.layer),
)

// Services + middleware
const PlatformLive = Layer.mergeAll(
  DatabaseService.layer,
  NodeClientService.layer,
  AuthService.layer,
  WalletService.layer,
  SseRelayService.layer,
  RateLimiterService.layer,
  AuthMiddlewareLive,
  AdminMiddlewareLive,
).pipe(Layer.provideMerge(ConfigAndDbLive))

// Handlers
const HandlersLive = Layer.mergeAll(
  AuthHandlersLive,
  TradingHandlersLive,
  MarketsHandlersLive,
  WalletHandlersLive,
  UserHandlersLive,
  LeaderboardHandlersLive,
  AdminHandlersLive,
  OracleHandlersLive,
  EventsHandlersLive,
).pipe(Layer.provide(PlatformLive))

// Everything composed
const AppLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(HttpApiBuilder.middlewareCors({
    allowedOrigins: [process.env.CORS_ORIGIN ?? "https://wpm.example.com"],
    allowedMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })),
  Layer.provide(HttpApiBuilder.api(WpmApi).pipe(Layer.provide(HandlersLive))),
  Layer.provide(PlatformLive),
  Layer.provide(
    BunHttpServer.layer({ port: Number(process.env.API_PORT) || 3000 }),
  ),
)

BunRuntime.runMain(Layer.launch(AppLive) as any)
