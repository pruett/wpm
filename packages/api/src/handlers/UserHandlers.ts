import { Effect } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { calculatePrices } from "@wpm/shared/amm"
import type { Block } from "@wpm/shared"
import { WpmApi } from "../Api"
import { CurrentUser } from "../middleware/AuthMiddleware"
import { Unauthorized, NodeUnavailable } from "../errors"
import { NodeClientService } from "../services/NodeClient"
import { DatabaseService } from "../services/DatabaseService"
import { round2 } from "../Schemas"

export const UserHandlersLive = HttpApiBuilder.group(WpmApi, "user", (handlers) =>
  Effect.gen(function*() {
    const node = yield* NodeClientService
    const db = yield* DatabaseService

    return handlers
      .handle("profile", () =>
        Effect.gen(function*() {
          const user = yield* CurrentUser

          const row = yield* db.findUserById(user.sub)
          if (!row) {
            return yield* Effect.fail(
              new Unauthorized({ message: "User not found" }),
            )
          }

          return {
            userId: row.id,
            name: row.name,
            email: row.email,
            walletAddress: row.wallet_address,
            createdAt: row.created_at,
          }
        }),
      )
      .handle("positions", () =>
        Effect.gen(function*() {
          const user = yield* CurrentUser
          const walletAddress = user.walletAddress

          if (!walletAddress) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Token missing wallet address" }),
            )
          }

          const sharesResult = yield* node.getShares(walletAddress)
          const stateResult = yield* node.getState()

          const { markets, pools } = stateResult

          const positions: {
            marketId: string
            market: {
              sport: string
              homeTeam: string
              awayTeam: string
              outcomeA: string
              outcomeB: string
              eventStartTime: number
            }
            outcome: string
            shares: number
            costBasis: number
            currentPrice: number
            estimatedValue: number
          }[] = []

          for (const [marketId, outcomeMap] of Object.entries(sharesResult.positions)) {
            const market = markets[marketId]
            if (!market || market.status !== "open") continue

            const pool = pools[marketId]
            const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 }

            for (const [outcome, pos] of Object.entries(outcomeMap)) {
              if (pos.shares <= 0) continue

              const price = outcome === "A" ? prices.priceA : prices.priceB
              positions.push({
                marketId,
                market: {
                  sport: market.sport,
                  homeTeam: market.homeTeam,
                  awayTeam: market.awayTeam,
                  outcomeA: market.outcomeA,
                  outcomeB: market.outcomeB,
                  eventStartTime: market.eventStartTime,
                },
                outcome,
                shares: pos.shares,
                costBasis: pos.costBasis,
                currentPrice: round2(price),
                estimatedValue: round2(pos.shares * price),
              })
            }
          }

          return { positions: positions as unknown }
        }),
      )
      .handle("history", () =>
        Effect.gen(function*() {
          const user = yield* CurrentUser
          const walletAddress = user.walletAddress

          if (!walletAddress) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Token missing wallet address" }),
            )
          }

          const stateResult = yield* node.getState()
          const { markets } = stateResult

          // Scan all blocks for user's PlaceBet costs and SettlePayout receipts
          const costByMarket = new Map<string, number>()
          const payoutsByMarket = new Map<string, number>()
          let from = 0
          const batchSize = 100

          while (true) {
            const blocks = yield* node.getBlocks(from, batchSize)
            if (blocks.length === 0) break

            for (const block of blocks) {
              for (const tx of block.transactions) {
                if (tx.type === "PlaceBet" && tx.sender === walletAddress) {
                  const current = costByMarket.get(tx.marketId) ?? 0
                  costByMarket.set(tx.marketId, current + tx.amount)
                } else if (
                  tx.type === "SettlePayout" &&
                  tx.recipient === walletAddress &&
                  tx.payoutType !== "liquidity_return"
                ) {
                  const current = payoutsByMarket.get(tx.marketId) ?? 0
                  payoutsByMarket.set(tx.marketId, current + tx.amount)
                }
              }
            }

            if (blocks.length < batchSize) break
            from += blocks.length
          }

          const involvedMarketIds = new Set<string>([
            ...costByMarket.keys(),
            ...payoutsByMarket.keys(),
          ])

          const history: {
            marketId: string
            market: {
              sport: string
              homeTeam: string
              awayTeam: string
              outcomeA: string
              outcomeB: string
              status: string
              winningOutcome?: string
              finalScore?: string
              resolvedAt?: number
            }
            costBasis: number
            payout: number
            profit: number
          }[] = []

          for (const marketId of involvedMarketIds) {
            const market = markets[marketId]
            if (!market || (market.status !== "resolved" && market.status !== "cancelled")) continue

            const costBasis = costByMarket.get(marketId) ?? 0
            const payout = payoutsByMarket.get(marketId) ?? 0
            const profit = round2(payout - costBasis)

            history.push({
              marketId,
              market: {
                sport: market.sport,
                homeTeam: market.homeTeam,
                awayTeam: market.awayTeam,
                outcomeA: market.outcomeA,
                outcomeB: market.outcomeB,
                status: market.status,
                ...(market.winningOutcome !== undefined && { winningOutcome: market.winningOutcome }),
                ...(market.finalScore !== undefined && { finalScore: market.finalScore }),
                ...(market.resolvedAt !== undefined && { resolvedAt: market.resolvedAt }),
              },
              costBasis,
              payout,
              profit,
            })
          }

          history.sort((a, b) => (b.market.resolvedAt ?? 0) - (a.market.resolvedAt ?? 0))

          return { history: history as unknown }
        }),
      )
  }),
)
