import { Effect } from "effect"
import { HttpApiBuilder } from "@effect/platform"
import type { TransferTx, Transaction, Block } from "@wpm/shared"
import { WpmApi } from "../Api"
import { CurrentUser } from "../middleware/AuthMiddleware"
import {
  Unauthorized,
  RecipientNotFound,
  InvalidAmount,
  InvalidTransfer,
  InsufficientBalance,
  InternalError,
  NodeUnavailable,
} from "../errors"
import { NodeClientService, NodeErrorResult } from "../services/NodeClient"
import { DatabaseService } from "../services/DatabaseService"
import { WalletService } from "../services/WalletService"
import { clampPagination } from "../Schemas"

function isUserTransaction(tx: Transaction, walletAddress: string): boolean {
  if (tx.sender === walletAddress) return true
  if ("recipient" in tx && tx.recipient === walletAddress) return true
  return false
}

export const WalletHandlersLive = HttpApiBuilder.group(WpmApi, "wallet", (handlers) =>
  Effect.gen(function*() {
    const node = yield* NodeClientService
    const db = yield* DatabaseService
    const walletSvc = yield* WalletService

    return handlers
      .handle("balance", () =>
        Effect.gen(function*() {
          const user = yield* CurrentUser
          const walletAddress = user.walletAddress

          if (!walletAddress) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Token missing wallet address" }),
            )
          }

          const result = yield* node.getBalance(walletAddress)

          return {
            address: result.address,
            balance: result.balance,
          }
        }),
      )
      .handle("transactions", ({ urlParams }) =>
        Effect.gen(function*() {
          const user = yield* CurrentUser
          const walletAddress = user.walletAddress

          if (!walletAddress) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Token missing wallet address" }),
            )
          }

          const { limit, offset } = clampPagination(
            { limit: urlParams.limit, offset: urlParams.offset },
            { limit: 50, maxLimit: 200 },
          )

          // Fetch all blocks from node in batches
          const allTransactions: Transaction[] = []
          let from = 0
          const batchSize = 100

          while (true) {
            const blocks = yield* node.getBlocks(from, batchSize)

            for (const block of blocks) {
              for (const tx of block.transactions) {
                if (isUserTransaction(tx, walletAddress)) {
                  allTransactions.push(tx)
                }
              }
            }

            if (blocks.length < batchSize) break
            from += blocks.length
          }

          // Sort by timestamp descending
          allTransactions.sort((a, b) => b.timestamp - a.timestamp)

          // Apply pagination
          const paginated = allTransactions.slice(offset, offset + limit)

          return {
            transactions: paginated as unknown,
            total: allTransactions.length,
            limit,
            offset,
          }
        }),
      )
      .handle("transfer", ({ payload }) =>
        Effect.gen(function*() {
          const user = yield* CurrentUser
          const walletAddress = user.walletAddress

          if (!walletAddress) {
            return yield* Effect.fail(
              new Unauthorized({ message: "Token missing wallet address" }),
            )
          }

          const { recipientAddress, amount } = payload

          // Validate amount
          if (
            !Number.isFinite(amount) ||
            amount <= 0 ||
            (() => {
              const parts = amount.toString().split(".")
              return !!(parts[1] && parts[1].length > 2)
            })()
          ) {
            return yield* Effect.fail(
              new InvalidAmount({ message: "Invalid amount" }),
            )
          }

          if (!recipientAddress) {
            return yield* Effect.fail(
              new RecipientNotFound({ message: "Recipient address is required" }),
            )
          }

          // No self-transfer
          if (walletAddress === recipientAddress) {
            return yield* Effect.fail(
              new InvalidTransfer({ message: "Cannot transfer to yourself" }),
            )
          }

          // Validate recipient exists
          const recipient = yield* db.findUserByWallet(recipientAddress)
          if (!recipient) {
            return yield* Effect.fail(
              new RecipientNotFound({ message: "Recipient not found" }),
            )
          }

          const privateKey = yield* walletSvc.getUserPrivateKey(user.sub)

          const tx: TransferTx = {
            id: crypto.randomUUID(),
            type: "Transfer",
            timestamp: Date.now(),
            sender: walletAddress,
            signature: "",
            recipient: recipientAddress,
            amount,
          }

          yield* walletSvc.signTransaction(tx, privateKey)

          const result = yield* node.submitTransaction(tx).pipe(
            Effect.mapError((e): InsufficientBalance | InvalidTransfer | NodeUnavailable | InternalError => {
              if (e._tag === "NodeUnavailable") return e
              if (e._tag === "NodeErrorResult") {
                if (e.error.code === "INSUFFICIENT_BALANCE") {
                  return new InsufficientBalance({ message: "Insufficient WPM balance" })
                }
                if (e.error.code === "SELF_TRANSFER") {
                  return new InvalidTransfer({ message: "Cannot transfer to yourself" })
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
            recipient: recipientAddress,
            amount,
            status: "accepted" as const,
          }
        }),
      )
  }),
)
