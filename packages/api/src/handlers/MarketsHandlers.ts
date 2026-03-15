import { Effect } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { calculatePrices } from "@wpm/shared/amm"
import { WpmApi } from "../Api"
import { CurrentUser } from "../middleware/AuthMiddleware"
import { MarketNotFound, NodeUnavailable } from "../errors"
import { NodeClientService, MarketNotFoundResult } from "../services/NodeClient"
import { DatabaseService } from "../services/DatabaseService"
import { round2, clampPagination } from "../Schemas"

export const MarketsHandlersLive = HttpApiBuilder.group(WpmApi, "markets", (handlers) =>
  Effect.gen(function*() {
    const node = yield* NodeClientService
    const db = yield* DatabaseService

    return handlers
      .handle("listOpen", () =>
        Effect.gen(function*() {
          const state = yield* node.getState()
          const { markets: allMarkets, pools } = state

          const openMarkets = Object.values(allMarkets).filter((m) => m.status === "open")

          // Fetch all blocks to compute volume per market
          const allBlocks = yield* node.fetchAllBlocks()
          const volumeByMarket = new Map<string, number>()

          for (const block of allBlocks) {
            for (const tx of block.transactions) {
              if (tx.type === "PlaceBet") {
                const current = volumeByMarket.get(tx.marketId) ?? 0
                volumeByMarket.set(tx.marketId, current + tx.amount)
              } else if (tx.type === "SellShares") {
                const current = volumeByMarket.get(tx.marketId) ?? 0
                volumeByMarket.set(tx.marketId, current + tx.shareAmount)
              }
            }
          }

          // Enrich markets with prices, multipliers, and volume
          const enriched = openMarkets.map((market) => {
            const pool = pools[market.marketId]
            const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 }
            const totalVolume = volumeByMarket.get(market.marketId) ?? 0

            return {
              ...market,
              prices,
              multipliers: {
                multiplierA: prices.priceA > 0 ? round2(1 / prices.priceA) : 0,
                multiplierB: prices.priceB > 0 ? round2(1 / prices.priceB) : 0,
              },
              totalVolume,
            }
          })

          return { markets: enriched }
        }),
      )
      .handle("listResolved", ({ urlParams }) =>
        Effect.gen(function*() {
          const state = yield* node.getState()
          const { markets: allMarkets } = state

          const settled = Object.values(allMarkets).filter(
            (m) => m.status === "resolved" || m.status === "cancelled",
          )

          settled.sort((a, b) => {
            const timeA = a.resolvedAt ?? a.createdAt
            const timeB = b.resolvedAt ?? b.createdAt
            return timeB - timeA
          })

          const { limit, offset } = clampPagination(urlParams)
          const paginated = settled.slice(offset, offset + limit)

          return {
            markets: paginated,
            total: settled.length,
            limit,
            offset,
          }
        }),
      )
      .handle("getMarket", ({ path }) =>
        Effect.gen(function*() {
          const { marketId } = path
          const user = yield* CurrentUser

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market, pool, prices } = marketResult

          let userPosition: {
            outcomeA: { shares: number; costBasis: number; estimatedValue: number } | null
            outcomeB: { shares: number; costBasis: number; estimatedValue: number } | null
          } | null = null

          if (user.walletAddress) {
            const sharesResult = yield* node.getShares(user.walletAddress).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )
            if (sharesResult) {
              const marketPositions = sharesResult.positions[marketId]
              if (marketPositions) {
                const posA = marketPositions["A"]
                const posB = marketPositions["B"]
                userPosition = {
                  outcomeA:
                    posA && posA.shares > 0
                      ? {
                          shares: posA.shares,
                          costBasis: posA.costBasis,
                          estimatedValue: round2(posA.shares * prices.priceA),
                        }
                      : null,
                  outcomeB:
                    posB && posB.shares > 0
                      ? {
                          shares: posB.shares,
                          costBasis: posB.costBasis,
                          estimatedValue: round2(posB.shares * prices.priceB),
                        }
                      : null,
                }
                if (!userPosition.outcomeA && !userPosition.outcomeB) {
                  userPosition = null
                }
              }
            }
          }

          return {
            market,
            pool: pool ?? null,
            prices,
            userPosition,
          }
        }),
      )
      .handle("getTrades", ({ path, urlParams }) =>
        Effect.gen(function*() {
          const { marketId } = path

          // Verify market exists
          yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          // Fetch all blocks, filter PlaceBet/SellShares for this market
          const allBlocks = yield* node.fetchAllBlocks()
          const trades: Array<Record<string, unknown>> = []

          for (const block of allBlocks) {
            for (const tx of block.transactions) {
              if (
                (tx.type === "PlaceBet" || tx.type === "SellShares") &&
                tx.marketId === marketId
              ) {
                trades.push(tx as unknown as Record<string, unknown>)
              }
            }
          }

          trades.sort((a, b) => (b.timestamp as number) - (a.timestamp as number))

          // Enrich with user display names
          const walletSet = new Set(trades.map((t) => t.sender as string))
          const namesByWallet = new Map<string, string>()
          for (const wallet of walletSet) {
            const user = yield* db.findUserByWallet(wallet)
            if (user) {
              namesByWallet.set(wallet, user.name)
            }
          }

          const { limit, offset } = clampPagination(urlParams)
          const paginated = trades.slice(offset, offset + limit)

          const enriched = paginated.map((tx) => ({
            ...tx,
            userName: namesByWallet.get(tx.sender as string) ?? null,
          }))

          return {
            trades: enriched,
            total: trades.length,
            limit,
            offset,
          }
        }),
      )
  }),
)
