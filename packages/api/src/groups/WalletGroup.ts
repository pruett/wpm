import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { AuthMiddleware } from "../middleware/AuthMiddleware"
import {
  Unauthorized,
  RecipientNotFound,
  InvalidAmount,
  InvalidTransfer,
  InsufficientBalance,
  InternalError,
  NodeUnavailable,
} from "../errors"
import { PaginationWide } from "../Schemas"

// --- Request/Response schemas ---

const BalanceResponse = Schema.Struct({
  address: Schema.String,
  balance: Schema.Number,
})

const TransactionsResponse = Schema.Struct({
  transactions: Schema.Unknown,
  total: Schema.Number,
  limit: Schema.Number,
  offset: Schema.Number,
})

const TransferPayload = Schema.Struct({
  recipientAddress: Schema.String,
  amount: Schema.Number,
})

const TransferResponse = Schema.Struct({
  txId: Schema.String,
  recipient: Schema.String,
  amount: Schema.Number,
  status: Schema.Literal("accepted"),
})

// --- Group ---

export class WalletGroup extends HttpApiGroup.make("wallet")
  .add(
    HttpApiEndpoint.get("balance", "/wallet/balance")
      .addSuccess(BalanceResponse)
      .addError(Unauthorized)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("transactions", "/wallet/transactions")
      .setUrlParams(PaginationWide)
      .addSuccess(TransactionsResponse)
      .addError(Unauthorized)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("transfer", "/wallet/transfer")
      .setPayload(TransferPayload)
      .addSuccess(TransferResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(RecipientNotFound)
      .addError(InvalidAmount)
      .addError(InvalidTransfer)
      .addError(InsufficientBalance)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .middleware(AuthMiddleware)
{}
