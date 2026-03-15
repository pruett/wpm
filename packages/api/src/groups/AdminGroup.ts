import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { AuthMiddleware } from "../middleware/AuthMiddleware"
import { AdminMiddleware } from "../middleware/AdminMiddleware"
import {
  Unauthorized,
  Forbidden,
  NotFound,
  RecipientNotFound,
  MarketNotFound,
  MarketClosed,
  MarketAlreadyResolved,
  MarketHasTrades,
  InvalidAmount,
  InvalidOutcome,
  InsufficientBalance,
  InternalError,
  NodeUnavailable,
} from "../errors"

// --- Request/Response schemas ---

const DistributePayload = Schema.Struct({
  recipient: Schema.String,
  amount: Schema.Number,
  reason: Schema.String,
})

const DistributeResponse = Schema.Struct({
  txId: Schema.String,
  recipient: Schema.String,
  amount: Schema.Number,
  reason: Schema.String,
  status: Schema.Literal("accepted"),
})

const CreateInviteCodesPayload = Schema.Struct({
  count: Schema.Number,
  maxUses: Schema.Number,
  referrer: Schema.optional(Schema.String),
})

const CreateInviteCodesResponse = Schema.Struct({
  codes: Schema.Array(Schema.String),
})

const ListInviteCodesResponse = Schema.Struct({
  inviteCodes: Schema.Unknown,
})

const CodePath = Schema.Struct({
  code: Schema.String,
})

const DeleteInviteCodeResponse = Schema.Struct({
  code: Schema.String,
  active: Schema.Boolean,
  message: Schema.optional(Schema.String),
})

const MarketIdPath = Schema.Struct({
  marketId: Schema.String,
})

const CancelMarketPayload = Schema.Struct({
  reason: Schema.String,
})

const CancelMarketResponse = Schema.Struct({
  txId: Schema.String,
  marketId: Schema.String,
  status: Schema.Literal("accepted"),
})

const ResolveMarketPayload = Schema.Struct({
  winningOutcome: Schema.Literal("A", "B"),
  finalScore: Schema.String,
})

const ResolveMarketResponse = Schema.Struct({
  txId: Schema.String,
  marketId: Schema.String,
  winningOutcome: Schema.String,
  status: Schema.Literal("accepted"),
})

const SeedMarketPayload = Schema.Struct({
  seedAmount: Schema.Number,
})

const SeedMarketResponse = Schema.Struct({
  cancelTxId: Schema.String,
  createTxId: Schema.String,
  oldMarketId: Schema.String,
  newMarketId: Schema.String,
  seedAmount: Schema.Number,
  status: Schema.Literal("accepted"),
})

const TreasuryResponse = Schema.Struct({
  treasuryAddress: Schema.String,
  balance: Schema.Number,
  totalDistributed: Schema.Number,
  totalSeeded: Schema.Number,
  totalReclaimed: Schema.Number,
})

const UsersResponse = Schema.Struct({
  users: Schema.Unknown,
})

// --- Group ---

export class AdminGroup extends HttpApiGroup.make("admin")
  .prefix("/admin")
  .add(
    HttpApiEndpoint.post("distribute", "/distribute")
      .setPayload(DistributePayload)
      .addSuccess(DistributeResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(RecipientNotFound)
      .addError(InvalidAmount)
      .addError(InsufficientBalance)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("createInviteCodes", "/invite-codes")
      .setPayload(CreateInviteCodesPayload)
      .addSuccess(CreateInviteCodesResponse, { status: 201 })
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(RecipientNotFound)
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.get("listInviteCodes", "/invite-codes")
      .addSuccess(ListInviteCodesResponse)
      .addError(Unauthorized)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.del("deleteInviteCode", "/invite-codes/:code")
      .setPath(CodePath)
      .addSuccess(DeleteInviteCodeResponse)
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.post("cancelMarket", "/markets/:marketId/cancel")
      .setPath(MarketIdPath)
      .setPayload(CancelMarketPayload)
      .addSuccess(CancelMarketResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(MarketNotFound)
      .addError(MarketClosed)
      .addError(MarketAlreadyResolved)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("resolveMarket", "/markets/:marketId/resolve")
      .setPath(MarketIdPath)
      .setPayload(ResolveMarketPayload)
      .addSuccess(ResolveMarketResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(MarketNotFound)
      .addError(MarketClosed)
      .addError(MarketAlreadyResolved)
      .addError(InvalidOutcome)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("seedMarket", "/markets/:marketId/seed")
      .setPath(MarketIdPath)
      .setPayload(SeedMarketPayload)
      .addSuccess(SeedMarketResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(MarketNotFound)
      .addError(MarketClosed)
      .addError(MarketAlreadyResolved)
      .addError(MarketHasTrades)
      .addError(InvalidAmount)
      .addError(InsufficientBalance)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("treasury", "/treasury")
      .addSuccess(TreasuryResponse)
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("users", "/users")
      .addSuccess(UsersResponse)
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("health", "/health")
      .addSuccess(Schema.Unknown)
      .addError(Unauthorized)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post("oracleIngest", "/oracle/ingest")
      .addSuccess(Schema.Unknown)
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("oracleResolve", "/oracle/resolve")
      .addSuccess(Schema.Unknown)
      .addError(Unauthorized)
      .addError(Forbidden)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .middleware(AuthMiddleware)
  .middleware(AdminMiddleware)
{}
