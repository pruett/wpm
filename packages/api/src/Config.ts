import { Config, Effect, Layer, Redacted } from "effect"

export type AppConfig = {
  readonly port: number
  readonly corsOrigin: string
  readonly dbPath: string
  readonly nodeUrl: string
  readonly jwtSecret: Redacted.Redacted
  readonly walletEncryptionKey: Redacted.Redacted
  readonly webauthnRpId: string
  readonly webauthnRpName: string
  readonly webauthnOrigin: string
  readonly adminApiKey: Redacted.Redacted | undefined
  readonly oraclePublicKey: string | undefined
  readonly oraclePrivateKey: Redacted.Redacted | undefined
  readonly oracleUrl: string
}

export class AppConfigService extends Effect.Tag("AppConfig")<AppConfigService, AppConfig>() {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function*() {
      const port = yield* Config.integer("API_PORT").pipe(Config.withDefault(3000))
      const corsOrigin = yield* Config.string("CORS_ORIGIN").pipe(
        Config.withDefault("https://wpm.example.com"),
      )
      const dbPath = yield* Config.string("DB_PATH").pipe(Config.withDefault("wpm-api.db"))
      const nodeUrl = yield* Config.string("NODE_URL").pipe(
        Config.withDefault("http://localhost:3001"),
      )
      const jwtSecret = yield* Config.redacted("JWT_SECRET")
      const walletEncryptionKey = yield* Config.redacted("WALLET_ENCRYPTION_KEY")
      const webauthnRpId = yield* Config.string("WEBAUTHN_RP_ID").pipe(
        Config.withDefault("localhost"),
      )
      const webauthnRpName = yield* Config.string("WEBAUTHN_RP_NAME").pipe(
        Config.withDefault("WPM"),
      )
      const webauthnOriginCfg = yield* Config.string("WEBAUTHN_ORIGIN").pipe(
        Config.option,
      )
      const webauthnOrigin =
        webauthnOriginCfg._tag === "Some" ? webauthnOriginCfg.value : `https://${webauthnRpId}`
      const adminApiKey = yield* Config.redacted("ADMIN_API_KEY").pipe(
        Config.option,
        Effect.map((o) => (o._tag === "Some" ? o.value : undefined)),
      )
      const oraclePublicKey = yield* Config.string("ORACLE_PUBLIC_KEY").pipe(
        Config.option,
        Effect.map((o) => (o._tag === "Some" ? o.value : undefined)),
      )
      const oraclePrivateKey = yield* Config.redacted("ORACLE_PRIVATE_KEY").pipe(
        Config.option,
        Effect.map((o) => (o._tag === "Some" ? o.value : undefined)),
      )
      const oracleUrl = yield* Config.string("ORACLE_URL").pipe(
        Config.withDefault("http://wpm-oracle:3001"),
      )

      return {
        port,
        corsOrigin,
        dbPath,
        nodeUrl,
        jwtSecret,
        walletEncryptionKey,
        webauthnRpId,
        webauthnRpName,
        webauthnOrigin,
        adminApiKey,
        oraclePublicKey,
        oraclePrivateKey,
        oracleUrl,
      }
    }),
  )
}
