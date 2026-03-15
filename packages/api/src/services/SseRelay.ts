import { Effect, Layer, Ref, PubSub, Queue, Stream, Fiber, Schedule, Scope } from "effect"
import { calculatePrices } from "@wpm/shared/amm"
import type { Block, Transaction } from "@wpm/shared"
import { NodeClientService } from "./NodeClient"
import type { StateResponse } from "./NodeClient"
import { DatabaseService } from "./DatabaseService"
import { round2 } from "../Schemas"

const KEEPALIVE_INTERVAL_MS = 30_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

type ClientEvent = {
  event: string
  data: unknown
  id?: string
}

type ParsedSSEEvent = {
  event: string
  data: string
}

type TradeExecutedData = {
  marketId: string
  outcome: string
  sender: string
  amount: number
  sharesReceived: number
  newPriceA: number
  newPriceB: number
}

type MarketResolvedData = {
  marketId: string
  winningOutcome: string
  finalScore: string
}

type MarketCancelledData = {
  marketId: string
  reason: string
}

type BlockNewData = {
  index: number
  hash: string
  txCount: number
  timestamp: number
}

export class SseRelayService extends Effect.Tag("SseRelay")<
  SseRelayService,
  {
    readonly subscribe: (
      userId: string,
      lastEventId?: string,
    ) => Effect.Effect<ReadableStream, never, Scope.Scope>
    readonly connectedClients: Effect.Effect<number>
    readonly close: Effect.Effect<void>
  }
>() {
  static readonly layer = Layer.scoped(
    this,
    Effect.gen(function*() {
      const node = yield* NodeClientService
      const db = yield* DatabaseService
      const pubsub = yield* PubSub.unbounded<ClientEvent>()
      const clients = yield* Ref.make(new Map<string, { close: () => void }>())
      const volumeByMarket = yield* Ref.make(new Map<string, number>())
      const pendingSettlementMarketIds = yield* Ref.make(new Set<string>())
      const encoder = new TextEncoder()

      const getVolume = (marketId: string) =>
        Ref.get(volumeByMarket).pipe(
          Effect.map((m) => round2(m.get(marketId) ?? 0)),
        )

      const addVolume = (marketId: string, amount: number) =>
        Ref.update(volumeByMarket, (m) => {
          const next = new Map(m)
          next.set(marketId, (next.get(marketId) ?? 0) + amount)
          return next
        })

      // Initialize volume from chain history
      const initVolume = Effect.gen(function*() {
        const blocks = yield* node.fetchAllBlocks().pipe(Effect.catchAll(() => Effect.succeed([])))
        for (const block of blocks) {
          for (const tx of block.transactions) {
            if (tx.type === "PlaceBet") {
              yield* addVolume(tx.marketId, tx.amount)
            } else if (tx.type === "SellShares") {
              yield* addVolume(tx.marketId, tx.shareAmount)
            }
          }
        }
      })

      const transformTradeExecuted = (data: TradeExecutedData): Effect.Effect<ClientEvent[]> =>
        Effect.gen(function*() {
          const events: ClientEvent[] = []

          yield* addVolume(data.marketId, data.amount)
          const totalVolume = yield* getVolume(data.marketId)

          events.push({
            event: "price:update",
            data: {
              marketId: data.marketId,
              priceA: data.newPriceA,
              priceB: data.newPriceB,
              multiplierA: data.newPriceA > 0 ? round2(1 / data.newPriceA) : 0,
              multiplierB: data.newPriceB > 0 ? round2(1 / data.newPriceB) : 0,
              totalVolume,
            },
          })

          let userId: string | null = null
          let userName: string | null = null
          const userRow = yield* db.findUserByWallet(data.sender).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (userRow) {
            userId = userRow.id
            userName = userRow.name
          }

          events.push({
            event: "bet:placed",
            data: {
              marketId: data.marketId,
              userId,
              userName,
              outcome: data.outcome,
              amount: data.amount,
              sharesReceived: data.sharesReceived,
            },
          })

          const balanceResult = yield* node.getBalance(data.sender).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (balanceResult) {
            events.push({
              event: "balance:update",
              data: { address: data.sender, balance: balanceResult.balance },
            })
          }

          return events
        })

      const computeLeaderboard = Effect.gen(function*() {
        const stateResult = yield* node.getState().pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        )
        if (!stateResult) return []

        const { balances, markets, pools } = stateResult
        const users = yield* db.getAllUsers().pipe(
          Effect.catchAll(() => Effect.succeed([] as const)),
        )

        const entries: {
          rank: number
          userId: string
          name: string
          walletAddress: string
          balance: number
          positionValue: number
          totalWpm: number
        }[] = []

        for (const user of users) {
          const balance = balances[user.wallet_address] ?? 0
          let positionValue = 0

          const sharesResult = yield* node.getShares(user.wallet_address).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (sharesResult) {
            for (const [marketId, outcomeMap] of Object.entries(sharesResult.positions)) {
              const market = markets[marketId]
              if (!market || market.status !== "open") continue
              const pool = pools[marketId]
              const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 }
              for (const [outcome, pos] of Object.entries(outcomeMap)) {
                if (pos.shares <= 0) continue
                const price = outcome === "A" ? prices.priceA : prices.priceB
                positionValue += pos.shares * price
              }
            }
          }

          positionValue = round2(positionValue)
          const totalWpm = round2(balance + positionValue)

          entries.push({
            rank: 0,
            userId: user.id,
            name: user.name,
            walletAddress: user.wallet_address,
            balance,
            positionValue,
            totalWpm,
          })
        }

        entries.sort((a, b) => {
          if (b.totalWpm !== a.totalWpm) return b.totalWpm - a.totalWpm
          return a.walletAddress.localeCompare(b.walletAddress)
        })

        return entries.map((e, i) => ({ ...e, rank: i + 1 }))
      })

      const transformBlockNew = (data: BlockNewData): Effect.Effect<ClientEvent[]> =>
        Effect.gen(function*() {
          const events: ClientEvent[] = []

          const pending = yield* Ref.get(pendingSettlementMarketIds)
          if (pending.size > 0) {
            yield* Ref.set(pendingSettlementMarketIds, new Set<string>())

            const blockResult = yield* node.getBlock(data.index).pipe(
              Effect.catchAll(() => Effect.succeed(null)),
            )

            if (blockResult) {
              const affectedAddresses = new Set<string>()

              for (const tx of blockResult.transactions) {
                if (
                  tx.type === "SettlePayout" &&
                  pending.has(tx.marketId) &&
                  tx.payoutType !== "liquidity_return"
                ) {
                  events.push({
                    event: "payout:received",
                    data: {
                      address: tx.recipient,
                      marketId: tx.marketId,
                      amount: tx.amount,
                    },
                  })
                  affectedAddresses.add(tx.recipient)
                }
              }

              for (const address of affectedAddresses) {
                const balResult = yield* node.getBalance(address).pipe(
                  Effect.catchAll(() => Effect.succeed(null)),
                )
                if (balResult) {
                  events.push({
                    event: "balance:update",
                    data: { address, balance: balResult.balance },
                  })
                }
              }

              const rankings = yield* computeLeaderboard.pipe(
                Effect.catchAll(() => Effect.succeed([])),
              )
              if (rankings.length > 0) {
                events.push({
                  event: "leaderboard:update",
                  data: { rankings },
                })
              }
            }
          }

          events.push({
            event: "block:new",
            data: {
              blockIndex: data.index,
              timestamp: data.timestamp,
              transactionCount: data.txCount,
            },
            id: String(data.index),
          })

          return events
        })

      const transformEvent = (
        nodeEvent: string,
        data: unknown,
      ): Effect.Effect<ClientEvent[]> => {
        switch (nodeEvent) {
          case "trade:executed":
            return transformTradeExecuted(data as TradeExecutedData)
          case "market:created":
            return Effect.succeed([{ event: "market:created", data }])
          case "market:resolved": {
            const d = data as MarketResolvedData
            return Ref.update(pendingSettlementMarketIds, (s) => {
              const next = new Set(s)
              next.add(d.marketId)
              return next
            }).pipe(
              Effect.map(() => [
                {
                  event: "market:resolved",
                  data: {
                    marketId: d.marketId,
                    winningOutcome: d.winningOutcome,
                    finalScore: d.finalScore,
                  },
                },
              ]),
            )
          }
          case "market:cancelled": {
            const d = data as MarketCancelledData
            return Ref.update(pendingSettlementMarketIds, (s) => {
              const next = new Set(s)
              next.add(d.marketId)
              return next
            }).pipe(
              Effect.map(() => [
                {
                  event: "market:cancelled",
                  data: { marketId: d.marketId, reason: d.reason },
                },
              ]),
            )
          }
          case "block:new":
            return transformBlockNew(data as BlockNewData)
          default:
            return Effect.succeed([{ event: nodeEvent, data }])
        }
      }

      const parseSSEChunk = (chunk: string): ParsedSSEEvent | null => {
        let event = ""
        let data = ""
        for (const line of chunk.split("\n")) {
          if (line.startsWith(":")) continue
          if (line.startsWith("event: ")) event = line.slice(7)
          else if (line.startsWith("data: ")) data = line.slice(6)
        }
        if (!event || !data) return null
        return { event, data }
      }

      const eventsFromBlock = (block: Block, state: StateResponse | null): ClientEvent[] => {
        const events: ClientEvent[] = []
        for (const tx of block.transactions) {
          switch (tx.type) {
            case "CreateMarket":
              events.push({
                event: "market:created",
                data: {
                  marketId: tx.marketId,
                  sport: tx.sport,
                  homeTeam: tx.homeTeam,
                  awayTeam: tx.awayTeam,
                  eventStartTime: tx.eventStartTime,
                },
              })
              break
            case "PlaceBet":
            case "SellShares": {
              const pool = state?.pools[tx.marketId]
              let priceA = 0.5
              let priceB = 0.5
              if (pool) {
                const prices = calculatePrices(pool)
                priceA = prices.priceA
                priceB = prices.priceB
              }
              events.push({
                event: "price:update",
                data: {
                  marketId: tx.marketId,
                  priceA,
                  priceB,
                  multiplierA: priceA > 0 ? round2(1 / priceA) : 0,
                  multiplierB: priceB > 0 ? round2(1 / priceB) : 0,
                  totalVolume: 0,
                },
              })
              if (tx.type === "PlaceBet") {
                let userId: string | null = null
                let userName: string | null = null
                // Note: sync DB lookup not possible in Effect, skip enrichment for replay
                events.push({
                  event: "bet:placed",
                  data: {
                    marketId: tx.marketId,
                    userId,
                    userName,
                    outcome: tx.outcome,
                    amount: tx.amount,
                    sharesReceived: 0,
                  },
                })
              }
              break
            }
            case "ResolveMarket":
              events.push({
                event: "market:resolved",
                data: {
                  marketId: tx.marketId,
                  winningOutcome: tx.winningOutcome,
                  finalScore: tx.finalScore,
                },
              })
              break
            case "CancelMarket":
              events.push({
                event: "market:cancelled",
                data: { marketId: tx.marketId, reason: tx.reason },
              })
              break
            case "SettlePayout":
              if (tx.payoutType !== "liquidity_return") {
                events.push({
                  event: "payout:received",
                  data: {
                    address: tx.recipient,
                    marketId: tx.marketId,
                    amount: tx.amount,
                  },
                })
              }
              break
          }
        }
        events.push({
          event: "block:new",
          data: {
            blockIndex: block.index,
            timestamp: block.timestamp,
            transactionCount: block.transactions.length,
          },
          id: String(block.index),
        })
        return events
      }

      // Connect to node SSE — runs as a forked fiber
      const connectFiber = yield* Effect.gen(function*() {
        yield* initVolume.pipe(Effect.catchAll(() => Effect.void))

        const retrySchedule = Schedule.exponential(RECONNECT_BASE_MS).pipe(
          Schedule.either(Schedule.spaced(RECONNECT_MAX_MS)),
        )

        yield* Effect.gen(function*() {
          const config = yield* Effect.try(() => ({
            nodeUrl: process.env.NODE_URL ?? "http://localhost:3001",
          }))

          const res = yield* Effect.tryPromise(() =>
            fetch(`${config.nodeUrl}/internal/events`, {
              headers: { Accept: "text/event-stream" },
            }),
          )

          if (!res.ok || !res.body) {
            return yield* Effect.fail(new Error(`Node SSE returned ${res.status}`))
          }

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""

          try {
            while (true) {
              const { done, value } = yield* Effect.tryPromise(() => reader.read()).pipe(Effect.orDie)
              if (done) break

              buffer += decoder.decode(value, { stream: true })

              let boundary: number
              while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const chunk = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)

                const parsed = parseSSEChunk(chunk)
                if (parsed) {
                  let nodeData: unknown
                  try {
                    nodeData = JSON.parse(parsed.data)
                  } catch {
                    yield* PubSub.publish(pubsub, {
                      event: parsed.event,
                      data: parsed.data,
                    })
                    continue
                  }

                  const clientEvents = yield* transformEvent(parsed.event, nodeData)
                  for (const ce of clientEvents) {
                    yield* PubSub.publish(pubsub, ce)
                  }
                }
              }
            }
          } finally {
            reader.releaseLock()
          }

          return yield* Effect.fail(new Error("Stream ended"))
        }).pipe(
          Effect.retry(retrySchedule),
          Effect.catchAll(() => Effect.void),
        )
      }).pipe(Effect.forkScoped)

      // Cleanup on scope finalization
      yield* Effect.addFinalizer(() =>
        Ref.get(clients).pipe(
          Effect.flatMap((map) => {
            for (const [, entry] of map) {
              entry.close()
            }
            return Ref.set(clients, new Map())
          }),
        ),
      )

      return {
        subscribe: (userId: string, lastEventId?: string) =>
          Effect.gen(function*() {
            // Remove existing connection for this user
            const existing = yield* Ref.get(clients)
            const prev = existing.get(userId)
            if (prev) prev.close()

            const subscription = yield* PubSub.subscribe(pubsub)

            let controller: ReadableStreamDefaultController | null = null
            let keepaliveTimer: ReturnType<typeof setInterval> | null = null

            const stream = new ReadableStream({
              start(ctrl) {
                controller = ctrl

                keepaliveTimer = setInterval(() => {
                  try {
                    ctrl.enqueue(encoder.encode(": keepalive\n\n"))
                  } catch {
                    // Client disconnected
                  }
                }, KEEPALIVE_INTERVAL_MS)

                // Replay missed events if lastEventId provided
                if (lastEventId !== undefined) {
                  const fromBlock = parseInt(lastEventId, 10)
                  if (!isNaN(fromBlock)) {
                    // Replay in background - we can't use Effect here directly
                    // The replay will be handled by reading blocks
                    void (async () => {
                      try {
                        let from = fromBlock + 1
                        const batchSize = 50
                        // Fetch state for replay
                        const stateRes = await fetch(
                          `${process.env.NODE_URL ?? "http://localhost:3001"}/internal/state`,
                        )
                        const state = stateRes.ok ? ((await stateRes.json()) as StateResponse) : null

                        while (true) {
                          const blocksRes = await fetch(
                            `${process.env.NODE_URL ?? "http://localhost:3001"}/internal/blocks?from=${from}&limit=${batchSize}`,
                          )
                          if (!blocksRes.ok) break
                          const blocks = (await blocksRes.json()) as Block[]
                          if (blocks.length === 0) break

                          for (const block of blocks) {
                            const events = eventsFromBlock(block, state)
                            for (const ce of events) {
                              let raw = ""
                              if (ce.id) raw += `id: ${ce.id}\n`
                              raw += `event: ${ce.event}\ndata: ${JSON.stringify(ce.data)}\n\n`
                              try {
                                ctrl.enqueue(encoder.encode(raw))
                              } catch {
                                return
                              }
                            }
                          }

                          if (blocks.length < batchSize) break
                          from += blocks.length
                        }
                      } catch {
                        // Replay failed
                      }
                    })()
                  }
                }

                // Start consuming from PubSub
                void (async () => {
                  // Poll the subscription queue
                  const poll = async () => {
                    while (true) {
                      try {
                        // Use Effect.runPromise to dequeue
                        const item = await Effect.runPromise(
                          Queue.take(subscription),
                        )
                        let raw = ""
                        if (item.id) raw += `id: ${item.id}\n`
                        raw += `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`
                        try {
                          ctrl.enqueue(encoder.encode(raw))
                        } catch {
                          return // client disconnected
                        }
                      } catch {
                        return // queue shutdown
                      }
                    }
                  }
                  poll()
                })()
              },
              cancel() {
                if (keepaliveTimer) clearInterval(keepaliveTimer)
                Effect.runSync(
                  Ref.update(clients, (m) => {
                    const next = new Map(m)
                    next.delete(userId)
                    return next
                  }),
                )
              },
            })

            const closeEntry = () => {
              if (keepaliveTimer) clearInterval(keepaliveTimer)
              try {
                controller?.close()
              } catch {
                // already closed
              }
            }

            yield* Ref.update(clients, (m) => {
              const next = new Map(m)
              next.set(userId, { close: closeEntry })
              return next
            })

            return stream
          }),

        connectedClients: Ref.get(clients).pipe(Effect.map((m) => m.size)),

        close: Ref.get(clients).pipe(
          Effect.flatMap((map) => {
            for (const [, entry] of map) {
              entry.close()
            }
            return Ref.set(clients, new Map())
          }),
        ),
      }
    }),
  )
}
