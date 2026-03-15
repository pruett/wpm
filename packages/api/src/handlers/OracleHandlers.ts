import { Effect } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { verify } from "@wpm/shared/crypto"
import type { Transaction } from "@wpm/shared"
import { WpmApi } from "../Api"
import { AppConfigService } from "../Config"
import {
  Unauthorized,
  InternalError,
  NodeUnavailable,
} from "../errors"
import { NodeClientService } from "../services/NodeClient"

export const OracleHandlersLive = HttpApiBuilder.group(WpmApi, "oracle", (handlers) =>
  Effect.gen(function*() {
    const config = yield* AppConfigService
    const node = yield* NodeClientService

    return handlers
      .handle("submitTransaction", ({ payload }) =>
        Effect.gen(function*() {
          const oraclePublicKey = config.oraclePublicKey
          if (!oraclePublicKey) {
            return yield* Effect.fail(
              new InternalError({ message: "Oracle public key not configured" }),
            )
          }

          const tx = payload as Transaction

          // Validate sender matches oracle public key
          if (!tx || typeof tx !== "object" || !tx.sender || tx.sender !== oraclePublicKey) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Transaction sender must be the oracle" }),
            )
          }

          // Validate signature is present
          if (!tx.signature || typeof tx.signature !== "string") {
            return yield* Effect.fail(
              new Unauthorized({ message: "Transaction signature is required" }),
            )
          }

          // Verify signature against oracle public key
          const signData = JSON.stringify({ ...tx, signature: undefined })
          const isValid = verify(signData, tx.signature, oraclePublicKey)

          if (!isValid) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Invalid oracle signature" }),
            )
          }

          // Forward valid signed transaction to node
          const result = yield* node.submitTransaction(tx).pipe(
            Effect.mapError((e): NodeUnavailable | InternalError => {
              if (e._tag === "NodeUnavailable") return e
              if (e._tag === "NodeErrorResult") {
                if (e.status === 503) {
                  return new NodeUnavailable({ message: "Blockchain node is unreachable" })
                }
                return new InternalError({ message: e.error.message })
              }
              return new NodeUnavailable({ message: "Blockchain node is unreachable" })
            }),
          )

          return {
            txId: result.txId,
            status: "accepted" as const,
          }
        }),
      )
      .handle("listMarkets", ({ urlParams }) =>
        Effect.gen(function*() {
          const stateResult = yield* node.getState()

          const allMarkets = Object.values(stateResult.markets)

          const statusParam = urlParams.status
          if (!statusParam) {
            return { markets: allMarkets }
          }

          // Parse comma-separated status values
          const validStatuses = new Set(["open", "resolved", "cancelled"])
          const requestedStatuses = statusParam
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => validStatuses.has(s))

          if (requestedStatuses.length === 0) {
            return { markets: [] }
          }

          const filtered = allMarkets.filter((m) =>
            requestedStatuses.includes(m.status),
          )
          return { markets: filtered }
        }),
      )
  }),
)
