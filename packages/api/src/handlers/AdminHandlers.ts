import { Effect, Redacted } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import type { CancelMarketTx, ResolveMarketTx, CreateMarketTx } from "@wpm/shared"
import { WpmApi } from "../Api"
import { AppConfigService } from "../Config"
import { CurrentUser } from "../middleware/AuthMiddleware"
import {
  NotFound,
  Forbidden,
  RecipientNotFound,
  MarketNotFound,
  MarketClosed,
  MarketAlreadyResolved,
  MarketHasTrades,
  InvalidAmount,
  InsufficientBalance,
  InternalError,
  NodeUnavailable,
} from "../errors"
import { DatabaseService } from "../services/DatabaseService"
import { NodeClientService, NodeErrorResult } from "../services/NodeClient"
import { WalletService } from "../services/WalletService"
import { round2 } from "../Schemas"

// --- Helpers ---

const requireAdmin = Effect.flatMap(CurrentUser, (user) => {
  if (user.role !== "admin") {
    return Effect.fail(new Forbidden({ message: "Insufficient permissions" }))
  }
  return Effect.succeed(user)
})

const VALID_REASONS = new Set(["signup_airdrop", "referral_reward", "manual"])

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

function generateCode(): string {
  let code = ""
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  for (let i = 0; i < 8; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length]
  }
  return code
}

function validateMarketOpen(market: {
  status: string
}): MarketNotFound | MarketClosed | MarketAlreadyResolved | null {
  if (market.status !== "open") {
    if (market.status === "resolved") {
      return new MarketAlreadyResolved({ message: "Market is already resolved" })
    }
    return new MarketClosed({ message: "Market is already cancelled" })
  }
  return null
}

// --- Handlers ---

export const AdminHandlersLive = HttpApiBuilder.group(WpmApi, "admin", (handlers) =>
  Effect.gen(function*() {
    const config = yield* AppConfigService
    const db = yield* DatabaseService
    const node = yield* NodeClientService
    const walletSvc = yield* WalletService

    return handlers
      .handle("distribute", ({ payload }) =>
        Effect.gen(function*() {
          yield* requireAdmin
          const { recipient, amount, reason } = payload

          if (!VALID_REASONS.has(reason)) {
            return yield* Effect.fail(
              new InvalidAmount({
                message: `Invalid reason. Must be one of: ${[...VALID_REASONS].join(", ")}`,
              }),
            )
          }

          if (!recipient) {
            return yield* Effect.fail(
              new RecipientNotFound({ message: "Recipient address is required" }),
            )
          }

          if (!Number.isFinite(amount) || amount <= 0) {
            return yield* Effect.fail(
              new InvalidAmount({ message: "Amount must be a positive number" }),
            )
          }

          const result = yield* node.distribute(recipient, amount, reason).pipe(
            Effect.mapError((e): InsufficientBalance | NodeUnavailable | InternalError => {
              if (e._tag === "NodeUnavailable") return e
              if (e._tag === "NodeErrorResult") {
                if (e.error.code === "INSUFFICIENT_BALANCE") {
                  return new InsufficientBalance({ message: "Treasury has insufficient balance" })
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
            recipient,
            amount,
            reason,
            status: "accepted" as const,
          }
        }),
      )
      .handle("createInviteCodes", ({ payload }) =>
        Effect.gen(function*() {
          const { count, maxUses, referrer } = payload

          if (
            !Number.isInteger(count) ||
            count < 1 ||
            count > 100
          ) {
            return yield* Effect.fail(
              new InternalError({ message: "count must be an integer between 1 and 100" }),
            )
          }

          if (!Number.isInteger(maxUses) || maxUses < 1) {
            return yield* Effect.fail(
              new InternalError({ message: "maxUses must be a positive integer" }),
            )
          }

          let validatedReferrer: string | null = null
          if (referrer !== undefined && referrer !== null) {
            if (!referrer) {
              return yield* Effect.fail(
                new RecipientNotFound({ message: "referrer must be a valid wallet address" }),
              )
            }
            const referrerUser = yield* db.findUserByWallet(referrer)
            if (!referrerUser) {
              return yield* Effect.fail(
                new RecipientNotFound({ message: "Referrer wallet address not found" }),
              )
            }
            validatedReferrer = referrer
          }

          const codes: string[] = []
          const existingCodes = new Set<string>()
          while (codes.length < count) {
            const code = generateCode()
            if (!existingCodes.has(code)) {
              codes.push(code)
              existingCodes.add(code)
              yield* db.insertInviteCode({
                code,
                createdBy: "admin",
                referrer: validatedReferrer,
                maxUses,
              })
            }
          }

          return { codes }
        }),
      )
      .handle("listInviteCodes", () =>
        Effect.gen(function*() {
          const codes = yield* db.getAllInviteCodes()

          return {
            inviteCodes: codes.map((row) => ({
              code: row.code,
              createdBy: row.created_by,
              referrer: row.referrer,
              maxUses: row.max_uses,
              useCount: row.use_count,
              active: row.active === 1,
              createdAt: row.created_at,
            })),
          }
        }),
      )
      .handle("deleteInviteCode", ({ path }) =>
        Effect.gen(function*() {
          const { code } = path

          const existing = yield* db.findInviteCode(code)
          if (!existing) {
            return yield* Effect.fail(
              new NotFound({ message: "Invite code not found" }),
            )
          }

          if (existing.active === 0) {
            return { code, active: false, message: "Already deactivated" }
          }

          yield* db.deactivateInviteCode(code)

          return { code, active: false }
        }),
      )
      .handle("cancelMarket", ({ path, payload }) =>
        Effect.gen(function*() {
          const { marketId } = path
          const { reason } = payload

          if (!reason.trim()) {
            return yield* Effect.fail(
              new InternalError({ message: "reason is required" }),
            )
          }

          const oraclePublicKey = config.oraclePublicKey
          const oraclePrivateKey = config.oraclePrivateKey
          if (!oraclePublicKey || !oraclePrivateKey) {
            return yield* Effect.fail(
              new InternalError({ message: "Oracle keys not configured" }),
            )
          }

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market } = marketResult
          const statusErr = validateMarketOpen(market)
          if (statusErr) return yield* Effect.fail(statusErr)

          const tx: CancelMarketTx = {
            id: crypto.randomUUID(),
            type: "CancelMarket",
            timestamp: Date.now(),
            sender: oraclePublicKey,
            signature: "",
            marketId,
            reason: reason.trim(),
          }

          yield* walletSvc.signTransaction(tx, Redacted.value(oraclePrivateKey))

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
            marketId,
            status: "accepted" as const,
          }
        }),
      )
      .handle("resolveMarket", ({ path, payload }) =>
        Effect.gen(function*() {
          const { marketId } = path
          const { winningOutcome, finalScore } = payload

          if (!finalScore.trim()) {
            return yield* Effect.fail(
              new InternalError({ message: "finalScore is required" }),
            )
          }

          const oraclePublicKey = config.oraclePublicKey
          const oraclePrivateKey = config.oraclePrivateKey
          if (!oraclePublicKey || !oraclePrivateKey) {
            return yield* Effect.fail(
              new InternalError({ message: "Oracle keys not configured" }),
            )
          }

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market } = marketResult
          const statusErr = validateMarketOpen(market)
          if (statusErr) return yield* Effect.fail(statusErr)

          const tx: ResolveMarketTx = {
            id: crypto.randomUUID(),
            type: "ResolveMarket",
            timestamp: Math.max(Date.now(), market.eventStartTime),
            sender: oraclePublicKey,
            signature: "",
            marketId,
            winningOutcome,
            finalScore: finalScore.trim(),
          }

          yield* walletSvc.signTransaction(tx, Redacted.value(oraclePrivateKey))

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
            marketId,
            winningOutcome,
            status: "accepted" as const,
          }
        }),
      )
      .handle("seedMarket", ({ path, payload }) =>
        Effect.gen(function*() {
          const { marketId } = path
          const { seedAmount } = payload

          if (!Number.isFinite(seedAmount) || seedAmount <= 0) {
            return yield* Effect.fail(
              new InvalidAmount({ message: "seedAmount must be a positive number" }),
            )
          }

          const oraclePublicKey = config.oraclePublicKey
          const oraclePrivateKey = config.oraclePrivateKey
          if (!oraclePublicKey || !oraclePrivateKey) {
            return yield* Effect.fail(
              new InternalError({ message: "Oracle keys not configured" }),
            )
          }

          const marketResult = yield* node.getMarket(marketId).pipe(
            Effect.catchTag("MarketNotFoundResult", () =>
              Effect.fail(new MarketNotFound({ message: "Market not found" })),
            ),
          )

          const { market } = marketResult
          const statusErr = validateMarketOpen(market)
          if (statusErr) return yield* Effect.fail(statusErr)

          // Check for existing trades (PlaceBet/SellShares) on this market
          const blocks = yield* node.fetchAllBlocks()
          const hasTrades = blocks.some((block) =>
            block.transactions.some(
              (tx) =>
                (tx.type === "PlaceBet" || tx.type === "SellShares") &&
                tx.marketId === marketId,
            ),
          )

          if (hasTrades) {
            return yield* Effect.fail(
              new MarketHasTrades({ message: "Market has existing trades and cannot be re-seeded" }),
            )
          }

          // Cancel existing market
          const cancelTx: CancelMarketTx = {
            id: crypto.randomUUID(),
            type: "CancelMarket",
            timestamp: Date.now(),
            sender: oraclePublicKey,
            signature: "",
            marketId,
            reason: "Seed override",
          }

          yield* walletSvc.signTransaction(cancelTx, Redacted.value(oraclePrivateKey))

          const cancelResult = yield* node.submitTransaction(cancelTx).pipe(
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

          // Create new market with new marketId and externalEventId, same params, new seed
          const newMarketId = crypto.randomUUID()
          const newExternalEventId = `${market.externalEventId}-reseed-${crypto.randomUUID().slice(0, 8)}`

          const createTx: CreateMarketTx = {
            id: crypto.randomUUID(),
            type: "CreateMarket",
            timestamp: Date.now(),
            sender: oraclePublicKey,
            signature: "",
            marketId: newMarketId,
            sport: market.sport,
            homeTeam: market.homeTeam,
            awayTeam: market.awayTeam,
            outcomeA: market.outcomeA,
            outcomeB: market.outcomeB,
            eventStartTime: market.eventStartTime,
            seedAmount,
            externalEventId: newExternalEventId,
          }

          yield* walletSvc.signTransaction(createTx, Redacted.value(oraclePrivateKey))

          const createResult = yield* node.submitTransaction(createTx).pipe(
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
            cancelTxId: cancelResult.txId,
            createTxId: createResult.txId,
            oldMarketId: marketId,
            newMarketId,
            seedAmount,
            status: "accepted" as const,
          }
        }),
      )
      .handle("treasury", () =>
        Effect.gen(function*() {
          const genesisBlock = yield* node.getBlock(0)
          const treasuryAddress = genesisBlock.transactions[0].sender

          const stateResult = yield* node.getState()
          const balance = stateResult.balances[treasuryAddress] ?? 0

          const blocks = yield* node.fetchAllBlocks()

          let totalDistributed = 0
          let totalSeeded = 0
          let totalReclaimed = 0

          for (const block of blocks) {
            for (const tx of block.transactions) {
              if (tx.type === "Distribute") {
                totalDistributed += tx.amount
              } else if (tx.type === "CreateMarket") {
                totalSeeded += tx.seedAmount
              } else if (
                tx.type === "SettlePayout" &&
                tx.payoutType === "liquidity_return" &&
                tx.recipient === treasuryAddress
              ) {
                totalReclaimed += tx.amount
              }
            }
          }

          return {
            treasuryAddress,
            balance: round2(balance),
            totalDistributed: round2(totalDistributed),
            totalSeeded: round2(totalSeeded),
            totalReclaimed: round2(totalReclaimed),
          }
        }),
      )
      .handle("users", () =>
        Effect.gen(function*() {
          const stateResult = yield* node.getState()
          const allUsers = yield* db.getAllUsers()

          const enrichedUsers = allUsers.map((user) => ({
            userId: user.id,
            name: user.name,
            email: user.email,
            walletAddress: user.wallet_address,
            role: user.role,
            balance: stateResult.balances[user.wallet_address] ?? 0,
            createdAt: user.created_at,
          }))

          return { users: enrichedUsers }
        }),
      )
      .handle("health", () =>
        Effect.gen(function*() {
          const nodeHealth = yield* node.getHealth().pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )

          const apiVersion = "0.0.1"

          if (!nodeHealth) {
            return {
              status: "degraded",
              apiVersion,
              uptimeMs: process.uptime() * 1000,
              connectedSSEClients: 0,
              nodeReachable: false,
            }
          }

          return {
            status: "ok",
            apiVersion,
            uptimeMs: process.uptime() * 1000,
            connectedSSEClients: 0,
            nodeReachable: true,
            node: {
              blockHeight: nodeHealth.blockHeight,
              mempoolSize: nodeHealth.mempoolSize,
              uptimeMs: nodeHealth.uptimeMs,
            },
          }
        }),
      )
      .handle("oracleIngest", () =>
        Effect.gen(function*() {
          const oracleUrl = config.oracleUrl

          const result = yield* Effect.tryPromise({
            try: () =>
              fetch(`${oracleUrl}/trigger/ingest`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(30_000),
              }).then(async (res) => {
                const data = await res.json()
                if (!res.ok) {
                  throw new Error(JSON.stringify(data))
                }
                return data
              }),
            catch: () =>
              new NodeUnavailable({ message: "Oracle server is unreachable" }),
          })

          return result
        }),
      )
      .handle("oracleResolve", () =>
        Effect.gen(function*() {
          const oracleUrl = config.oracleUrl

          const result = yield* Effect.tryPromise({
            try: () =>
              fetch(`${oracleUrl}/trigger/resolve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(30_000),
              }).then(async (res) => {
                const data = await res.json()
                if (!res.ok) {
                  throw new Error(JSON.stringify(data))
                }
                return data
              }),
            catch: () =>
              new NodeUnavailable({ message: "Oracle server is unreachable" }),
          })

          return result
        }),
      )
  }),
)
