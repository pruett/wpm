import { Effect } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import { calculatePrices, calculateBuy, calculateSell } from "@wpm/shared/amm"
import type { Block, Transaction, AMMPool, SharePosition } from "@wpm/shared"
import { WpmApi } from "../Api"
import { NodeUnavailable } from "../errors"
import { NodeClientService } from "../services/NodeClient"
import { DatabaseService } from "../services/DatabaseService"
import { round2 } from "../Schemas"

// --- Helpers ---

function getWeekStartTimestamp(now?: Date): number {
  const d = now ?? new Date()
  const day = d.getUTCDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = day === 0 ? 6 : day - 1
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysSinceMonday,
    0,
    0,
    0,
    0,
  )
}

// --- StateSnapshot: lightweight chain state replay for computing historical balances/pools/positions ---

class StateSnapshot {
  balances = new Map<string, number>()
  pools = new Map<string, AMMPool>()
  markets = new Map<string, string>() // marketId -> status
  sharePositions = new Map<string, Map<string, Map<string, SharePosition>>>()
  private treasuryAddress: string

  constructor(treasuryAddress: string) {
    this.treasuryAddress = treasuryAddress
  }

  getBalance(address: string): number {
    return this.balances.get(address) ?? 0
  }

  private credit(address: string, amount: number): void {
    this.balances.set(address, this.getBalance(address) + amount)
  }

  private debit(address: string, amount: number): void {
    this.balances.set(address, this.getBalance(address) - amount)
  }

  getSharePosition(address: string, marketId: string, outcome: string): SharePosition {
    return (
      this.sharePositions.get(address)?.get(marketId)?.get(outcome) ?? {
        shares: 0,
        costBasis: 0,
      }
    )
  }

  private setSharePosition(
    address: string,
    marketId: string,
    outcome: string,
    position: SharePosition,
  ): void {
    if (!this.sharePositions.has(address)) this.sharePositions.set(address, new Map())
    const byAddr = this.sharePositions.get(address)!
    if (!byAddr.has(marketId)) byAddr.set(marketId, new Map())
    byAddr.get(marketId)!.set(outcome, position)
  }

  applyBlock(block: Block): void {
    const settledMarkets: string[] = []
    for (const tx of block.transactions) {
      this.applyTransaction(tx)
      if (tx.type === "ResolveMarket" || tx.type === "CancelMarket") {
        settledMarkets.push(tx.marketId)
      }
    }
    for (const marketId of settledMarkets) {
      this.pools.delete(marketId)
      for (const [, byMarket] of this.sharePositions) {
        byMarket.delete(marketId)
      }
    }
  }

  private applyTransaction(tx: Transaction): void {
    switch (tx.type) {
      case "Transfer":
        this.debit(tx.sender, tx.amount)
        this.credit(tx.recipient, tx.amount)
        break
      case "Distribute":
        if (tx.sender !== tx.recipient) this.debit(tx.sender, tx.amount)
        this.credit(tx.recipient, tx.amount)
        break
      case "CreateMarket": {
        this.debit(this.treasuryAddress, tx.seedAmount)
        const half = tx.seedAmount / 2
        this.pools.set(tx.marketId, {
          marketId: tx.marketId,
          sharesA: half,
          sharesB: half,
          k: half * half,
          wpmLocked: tx.seedAmount,
        })
        this.markets.set(tx.marketId, "open")
        break
      }
      case "PlaceBet": {
        const pool = this.pools.get(tx.marketId)!
        const result = calculateBuy(pool, tx.outcome, tx.amount)
        this.debit(tx.sender, tx.amount)
        this.pools.set(tx.marketId, result.pool)
        const pos = this.getSharePosition(tx.sender, tx.marketId, tx.outcome)
        this.setSharePosition(tx.sender, tx.marketId, tx.outcome, {
          shares: round2(pos.shares + result.sharesToUser),
          costBasis: round2(pos.costBasis + tx.amount),
        })
        break
      }
      case "SellShares": {
        const pool = this.pools.get(tx.marketId)!
        const result = calculateSell(pool, tx.outcome, tx.shareAmount)
        this.credit(tx.sender, result.netReturn)
        this.pools.set(tx.marketId, result.pool)
        const pos = this.getSharePosition(tx.sender, tx.marketId, tx.outcome)
        const costBasisReduction = round2(pos.costBasis * (tx.shareAmount / pos.shares))
        this.setSharePosition(tx.sender, tx.marketId, tx.outcome, {
          shares: round2(pos.shares - tx.shareAmount),
          costBasis: round2(pos.costBasis - costBasisReduction),
        })
        break
      }
      case "ResolveMarket":
        this.markets.set(tx.marketId, "resolved")
        break
      case "CancelMarket":
        this.markets.set(tx.marketId, "cancelled")
        break
      case "SettlePayout": {
        const pool = this.pools.get(tx.marketId)
        if (pool) pool.wpmLocked -= tx.amount
        this.credit(tx.recipient, tx.amount)
        break
      }
      case "Referral":
        this.debit(tx.sender, tx.amount)
        this.credit(tx.recipient, tx.amount)
        break
    }
  }
}

// --- Handlers ---

export const LeaderboardHandlersLive = HttpApiBuilder.group(WpmApi, "leaderboard", (handlers) =>
  Effect.gen(function*() {
    const node = yield* NodeClientService
    const db = yield* DatabaseService

    return handlers
      .handle("alltime", () =>
        Effect.gen(function*() {
          const stateResult = yield* node.getState()
          const { balances, markets, pools } = stateResult

          const users = yield* db.getAllUsers()

          const entries: {
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
            const sharesResult = yield* node.getShares(user.wallet_address)

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

            positionValue = round2(positionValue)
            const totalWpm = round2(balance + positionValue)

            entries.push({
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

          const rankings = entries.map((entry, i) => ({
            rank: i + 1,
            ...entry,
          }))

          return { rankings: rankings as unknown }
        }),
      )
      .handle("weekly", () =>
        Effect.gen(function*() {
          const stateResult = yield* node.getState()
          const {
            balances: currentBalances,
            markets: currentMarkets,
            pools: currentPools,
          } = stateResult

          const allBlocks = yield* node.fetchAllBlocks()

          const weekStart = getWeekStartTimestamp()

          const treasuryAddress = allBlocks[0]?.transactions[0]?.sender ?? ""
          const snapshot = new StateSnapshot(treasuryAddress)
          for (const block of allBlocks) {
            if (block.timestamp >= weekStart) break
            snapshot.applyBlock(block)
          }

          const users = yield* db.getAllUsers()

          const entries: {
            userId: string
            name: string
            walletAddress: string
            currentTotalWpm: number
            weekStartTotalWpm: number
            weeklyPnl: number
          }[] = []

          for (const user of users) {
            const currentBalance = currentBalances[user.wallet_address] ?? 0
            let currentPositionValue = 0
            const sharesResult = yield* node.getShares(user.wallet_address)

            for (const [marketId, outcomeMap] of Object.entries(sharesResult.positions)) {
              const market = currentMarkets[marketId]
              if (!market || market.status !== "open") continue
              const pool = currentPools[marketId]
              const prices = pool ? calculatePrices(pool) : { priceA: 0.5, priceB: 0.5 }
              for (const [outcome, pos] of Object.entries(outcomeMap)) {
                if (pos.shares <= 0) continue
                const price = outcome === "A" ? prices.priceA : prices.priceB
                currentPositionValue += pos.shares * price
              }
            }
            currentPositionValue = round2(currentPositionValue)
            const currentTotalWpm = round2(currentBalance + currentPositionValue)

            const historicalBalance = snapshot.getBalance(user.wallet_address)
            let historicalPositionValue = 0
            const historicalPositions = snapshot.sharePositions.get(user.wallet_address)
            if (historicalPositions) {
              for (const [marketId, outcomeMap] of historicalPositions) {
                const marketStatus = snapshot.markets.get(marketId)
                if (marketStatus !== "open") continue
                const pool = snapshot.pools.get(marketId)
                if (pool) {
                  const prices = calculatePrices(pool)
                  for (const [outcome, pos] of outcomeMap) {
                    if (pos.shares <= 0) continue
                    const price = outcome === "A" ? prices.priceA : prices.priceB
                    historicalPositionValue += pos.shares * price
                  }
                }
              }
            }
            historicalPositionValue = round2(historicalPositionValue)
            const weekStartTotalWpm = round2(historicalBalance + historicalPositionValue)

            const weeklyPnl = round2(currentTotalWpm - weekStartTotalWpm)

            entries.push({
              userId: user.id,
              name: user.name,
              walletAddress: user.wallet_address,
              currentTotalWpm,
              weekStartTotalWpm,
              weeklyPnl,
            })
          }

          entries.sort((a, b) => {
            if (b.weeklyPnl !== a.weeklyPnl) return b.weeklyPnl - a.weeklyPnl
            return a.walletAddress.localeCompare(b.walletAddress)
          })

          const rankings = entries.map((entry, i) => ({
            rank: i + 1,
            ...entry,
          }))

          return { rankings: rankings as unknown, weekStart }
        }),
      )
  }),
)
