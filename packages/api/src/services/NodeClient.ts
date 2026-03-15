import { Effect, Layer } from "effect"
import type { Transaction, Block, Market, AMMPool, SharePosition } from "@wpm/shared"
import { AppConfigService } from "../Config"
import { NodeUnavailable } from "../errors"

// --- Response types ---

export type NodeHealthResponse = {
  status: string
  blockHeight: number
  mempoolSize: number
  uptimeMs: number
}

export type BalanceResponse = {
  address: string
  balance: number
}

export type StateResponse = {
  blockHeight: number
  balances: Record<string, number>
  markets: Record<string, Market>
  pools: Record<string, AMMPool>
}

export type MarketResponse = {
  market: Market
  pool: AMMPool
  prices: { priceA: number; priceB: number }
}

export type SharesResponse = {
  address: string
  positions: Record<string, Record<string, SharePosition>>
}

export type TxResult = {
  txId: string
}

export type NodeError = {
  code: string
  message: string
}

// --- Internal error types ---

export class MarketNotFoundResult {
  readonly _tag = "MarketNotFoundResult" as const
}

export class NodeErrorResult {
  readonly _tag = "NodeErrorResult" as const
  readonly error: NodeError
  readonly status: number
  constructor(opts: { error: NodeError; status: number }) {
    this.error = opts.error
    this.status = opts.status
  }
}

// --- Service ---

const TIMEOUT_MS = 5000
const nodeUnavailable = new NodeUnavailable({ message: "Blockchain node is unreachable" })

export class NodeClientService extends Effect.Tag("NodeClient")<
  NodeClientService,
  {
    readonly getHealth: () => Effect.Effect<NodeHealthResponse, NodeUnavailable>
    readonly getBalance: (address: string) => Effect.Effect<BalanceResponse, NodeUnavailable>
    readonly getState: () => Effect.Effect<StateResponse, NodeUnavailable>
    readonly getMarket: (
      marketId: string,
    ) => Effect.Effect<MarketResponse, NodeUnavailable | MarketNotFoundResult>
    readonly getShares: (address: string) => Effect.Effect<SharesResponse, NodeUnavailable>
    readonly getBlocks: (from?: number, limit?: number) => Effect.Effect<Block[], NodeUnavailable>
    readonly getBlock: (index: number) => Effect.Effect<Block, NodeUnavailable>
    readonly submitTransaction: (
      tx: Transaction,
    ) => Effect.Effect<TxResult, NodeUnavailable | NodeErrorResult>
    readonly distribute: (
      recipient: string,
      amount: number,
      reason: string,
    ) => Effect.Effect<TxResult, NodeUnavailable | NodeErrorResult>
    readonly referralReward: (
      inviterAddress: string,
      referredUser: string,
    ) => Effect.Effect<TxResult, NodeUnavailable | NodeErrorResult>
    readonly fetchAllBlocks: () => Effect.Effect<Block[], NodeUnavailable>
  }
>() {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function*() {
      const config = yield* AppConfigService
      const baseUrl = config.nodeUrl

      const fetchGet = <T>(path: string): Effect.Effect<T, NodeUnavailable> =>
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${baseUrl}${path}`, {
              signal: AbortSignal.timeout(TIMEOUT_MS),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return (await res.json()) as T
          },
          catch: () => nodeUnavailable,
        })

      const fetchGetWithStatus = <T>(
        path: string,
      ): Effect.Effect<T, NodeUnavailable | MarketNotFoundResult> =>
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${baseUrl}${path}`, {
              signal: AbortSignal.timeout(TIMEOUT_MS),
            })
            const body = await res.json()
            if (res.ok) return { ok: true as const, data: body as T, status: res.status }
            return { ok: false as const, data: null as T, status: res.status }
          },
          catch: () => nodeUnavailable,
        }).pipe(
          Effect.flatMap((result): Effect.Effect<T, NodeUnavailable | MarketNotFoundResult> => {
            if (result.ok) return Effect.succeed(result.data)
            if (result.status === 404) return Effect.fail(new MarketNotFoundResult())
            return Effect.fail(nodeUnavailable)
          }),
        )

      const fetchPost = <T>(
        path: string,
        body: unknown,
      ): Effect.Effect<T, NodeUnavailable | NodeErrorResult> =>
        Effect.tryPromise({
          try: async () => {
            const res = await fetch(`${baseUrl}${path}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(TIMEOUT_MS),
            })
            const data = await res.json()
            if (res.ok || res.status === 202) return { ok: true as const, data: data as T }
            return { ok: false as const, error: data as NodeError, status: res.status }
          },
          catch: () => nodeUnavailable,
        }).pipe(
          Effect.flatMap((result) => {
            if (result.ok) return Effect.succeed(result.data)
            return Effect.fail(new NodeErrorResult({ error: result.error, status: result.status }))
          }),
        )

      return {
        getHealth: () => fetchGet<NodeHealthResponse>("/internal/health"),
        getBalance: (address) =>
          fetchGet<BalanceResponse>(`/internal/balance/${encodeURIComponent(address)}`),
        getState: () => fetchGet<StateResponse>("/internal/state"),
        getMarket: (marketId) =>
          fetchGetWithStatus<MarketResponse>(`/internal/market/${encodeURIComponent(marketId)}`),
        getShares: (address) =>
          fetchGet<SharesResponse>(`/internal/shares/${encodeURIComponent(address)}`),
        getBlocks: (from = 0, limit = 50) =>
          fetchGet<Block[]>(`/internal/blocks?from=${from}&limit=${limit}`),
        getBlock: (index) => fetchGet<Block>(`/internal/block/${index}`),
        submitTransaction: (tx) => fetchPost<TxResult>("/internal/transaction", tx),
        distribute: (recipient, amount, reason) =>
          fetchPost<TxResult>("/internal/distribute", { recipient, amount, reason }),
        referralReward: (inviterAddress, referredUser) =>
          fetchPost<TxResult>("/internal/referral-reward", { inviterAddress, referredUser }),
        fetchAllBlocks: () =>
          Effect.gen(function*() {
            const allBlocks: Block[] = []
            let from = 0
            const batchSize = 100
            while (true) {
              const blocks = yield* fetchGet<Block[]>(
                `/internal/blocks?from=${from}&limit=${batchSize}`,
              )
              allBlocks.push(...blocks)
              if (blocks.length < batchSize) break
              from += blocks.length
            }
            return allBlocks
          }),
      }
    }),
  )
}
