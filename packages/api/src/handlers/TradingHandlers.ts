import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { calculateBuy, calculateSell, calculatePrices } from "@wpm/shared/amm"
import type { PlaceBetTx, SellSharesTx } from "@wpm/shared"
import { WpmApi } from "../Api"
import { CurrentUser } from "../middleware/AuthMiddleware"
import {
  Unauthorized,
  MarketNotFound,
  MarketClosed,
  MarketAlreadyResolved,
  InvalidAmount,
  InsufficientBalance,
  InsufficientShares,
  InternalError,
  NodeUnavailable,
} from "../errors"
import { NodeClientService, MarketNotFoundResult, NodeErrorResult } from "../services/NodeClient"
import { WalletService } from "../services/WalletService"
import { round2 } from "../Schemas"

function validateAmountValue(n: number): boolean {
  if (!Number.isFinite(n) || n <= 0) return false
  const parts = n.toString().split(".")
  return !(parts[1] && parts[1].length > 2)
}

function validateMarketTradeable(market: {
  status: string
  eventStartTime: number
}): MarketNotFound | MarketClosed | MarketAlreadyResolved | null {
  if (market.status !== "open") {
    if (market.status === "resolved") {
      return new MarketAlreadyResolved({ message: "Market is already resolved" })
    }
    return new MarketClosed({ message: "Market betting window has closed" })
  }
  if (Date.now() >= market.eventStartTime) {
    return new MarketClosed({ message: "Market betting window has closed" })
  }
  return null
}

export const TradingHandlersLive = HttpApiBuilder.group(WpmApi, "trading", (handlers) =>
  Effect.gen(function*() {
    const node = yield* NodeClientService
    const walletSvc = yield* WalletService

    return handlers
      .handle("buyPreview", ({ path, payload }) =>
        Effect.gen(function*() {
          const { marketId } = path
          const { outcome, amount } = payload

          if (!validateAmountValue(amount)) {
            return yield* Effect.fail(new InvalidAmount({ message: "Invalid amount" }))
          }

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market, pool } = marketResult
          const marketErr = validateMarketTradeable(market)
          if (marketErr) return yield* Effect.fail(marketErr)

          const currentPrices = calculatePrices(pool)
          const buyResult = calculateBuy(pool, outcome, amount)
          const newPrices = calculatePrices(buyResult.pool)

          const fee = round2(amount * 0.01)
          const effectivePrice =
            buyResult.sharesToUser > 0 ? round2(amount / buyResult.sharesToUser) : 0

          const currentPrice = outcome === "A" ? currentPrices.priceA : currentPrices.priceB
          const newPrice = outcome === "A" ? newPrices.priceA : newPrices.priceB
          const priceImpact = round2(Math.abs(newPrice - currentPrice))

          return {
            sharesReceived: buyResult.sharesToUser,
            effectivePrice,
            priceImpact,
            fee,
            newPriceA: round2(newPrices.priceA),
            newPriceB: round2(newPrices.priceB),
          }
        }),
      )
      .handle("sellPreview", ({ path, payload }) =>
        Effect.gen(function*() {
          const { marketId } = path
          const { outcome, amount } = payload

          if (!validateAmountValue(amount)) {
            return yield* Effect.fail(new InvalidAmount({ message: "Invalid amount" }))
          }

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market, pool } = marketResult
          const marketErr = validateMarketTradeable(market)
          if (marketErr) return yield* Effect.fail(marketErr)

          const currentPrices = calculatePrices(pool)
          const sellResult = calculateSell(pool, outcome, amount)
          const newPrices = calculatePrices(sellResult.pool)

          const grossReturn =
            outcome === "A"
              ? round2(
                  pool.sharesB - (pool.sharesA * pool.sharesB) / (pool.sharesA + amount),
                )
              : round2(
                  pool.sharesA - (pool.sharesA * pool.sharesB) / (pool.sharesB + amount),
                )
          const fee = round2(grossReturn * 0.01)

          const effectivePrice = amount > 0 ? round2(sellResult.netReturn / amount) : 0

          const currentPrice = outcome === "A" ? currentPrices.priceA : currentPrices.priceB
          const newPrice = outcome === "A" ? newPrices.priceA : newPrices.priceB
          const priceImpact = round2(Math.abs(newPrice - currentPrice))

          return {
            wpmReceived: sellResult.netReturn,
            effectivePrice,
            priceImpact,
            fee,
            newPriceA: round2(newPrices.priceA),
            newPriceB: round2(newPrices.priceB),
          }
        }),
      )
      .handle("buy", ({ path, payload }) =>
        Effect.gen(function*() {
          const user = yield* CurrentUser
          const { marketId } = path
          const { outcome, amount } = payload

          if (!validateAmountValue(amount)) {
            return yield* Effect.fail(new InvalidAmount({ message: "Invalid amount" }))
          }

          const walletAddress = user.walletAddress
          if (!walletAddress) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Token missing wallet address" }),
            )
          }

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market } = marketResult
          const marketErr = validateMarketTradeable(market)
          if (marketErr) return yield* Effect.fail(marketErr)

          const privateKey = yield* walletSvc.getUserPrivateKey(user.sub)

          const tx: PlaceBetTx = {
            id: crypto.randomUUID(),
            type: "PlaceBet",
            timestamp: Date.now(),
            sender: walletAddress,
            signature: "",
            marketId,
            outcome,
            amount,
          }

          yield* walletSvc.signTransaction(tx, privateKey)

          const result = yield* node.submitTransaction(tx).pipe(
            Effect.mapError((e): InsufficientBalance | NodeUnavailable | InternalError => {
              if (e._tag === "NodeUnavailable") return e
              if (e._tag === "NodeErrorResult") {
                if (e.error.code === "INSUFFICIENT_BALANCE") {
                  return new InsufficientBalance({ message: "Insufficient WPM balance" })
                }
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
            marketId,
            outcome: outcome as "A" | "B",
            amount,
            status: "accepted" as const,
          }
        }),
      )
      .handle("sell", ({ path, payload }) =>
        Effect.gen(function*() {
          const user = yield* CurrentUser
          const { marketId } = path
          const { outcome, amount } = payload

          if (!validateAmountValue(amount)) {
            return yield* Effect.fail(new InvalidAmount({ message: "Invalid amount" }))
          }

          const walletAddress = user.walletAddress
          if (!walletAddress) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Token missing wallet address" }),
            )
          }

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market } = marketResult
          const marketErr = validateMarketTradeable(market)
          if (marketErr) return yield* Effect.fail(marketErr)

          // Validate shares
          const sharesResult = yield* node.getShares(walletAddress)
          const marketPositions = sharesResult.positions[marketId]
          const position = marketPositions?.[outcome]
          const heldShares = position?.shares ?? 0

          if (heldShares < amount) {
            return yield* Effect.fail(
              new InsufficientShares({ message: "Insufficient shares to sell" }),
            )
          }

          const privateKey = yield* walletSvc.getUserPrivateKey(user.sub)

          const tx: SellSharesTx = {
            id: crypto.randomUUID(),
            type: "SellShares",
            timestamp: Date.now(),
            sender: walletAddress,
            signature: "",
            marketId,
            outcome,
            shareAmount: amount,
          }

          yield* walletSvc.signTransaction(tx, privateKey)

          const result = yield* node.submitTransaction(tx).pipe(
            Effect.mapError((e): InsufficientShares | NodeUnavailable | InternalError => {
              if (e._tag === "NodeUnavailable") return e
              if (e._tag === "NodeErrorResult") {
                if (e.error.code === "INSUFFICIENT_SHARES") {
                  return new InsufficientShares({ message: "Insufficient shares to sell" })
                }
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
            marketId,
            outcome: outcome as "A" | "B",
            shareAmount: amount,
            status: "accepted" as const,
          }
        }),
      )
  }),
)
