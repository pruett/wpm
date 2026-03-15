import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { AuthMiddleware } from "../middleware/AuthMiddleware"
import {
  Unauthorized,
  MarketNotFound,
  MarketClosed,
  MarketAlreadyResolved,
  InvalidAmount,
  InvalidOutcome,
  InsufficientBalance,
  InsufficientShares,
  InternalError,
  NodeUnavailable,
} from "../errors"

const TradePayload = Schema.Struct({
  outcome: Schema.Literal("A", "B"),
  amount: Schema.Number.pipe(Schema.positive(), Schema.finite()),
})

const BuyPreviewResponse = Schema.Struct({
  sharesReceived: Schema.Number,
  effectivePrice: Schema.Number,
  priceImpact: Schema.Number,
  fee: Schema.Number,
  newPriceA: Schema.Number,
  newPriceB: Schema.Number,
})

const SellPreviewResponse = Schema.Struct({
  wpmReceived: Schema.Number,
  effectivePrice: Schema.Number,
  priceImpact: Schema.Number,
  fee: Schema.Number,
  newPriceA: Schema.Number,
  newPriceB: Schema.Number,
})

const BuyResponse = Schema.Struct({
  txId: Schema.String,
  marketId: Schema.String,
  outcome: Schema.Literal("A", "B"),
  amount: Schema.Number,
  status: Schema.Literal("accepted"),
})

const SellResponse = Schema.Struct({
  txId: Schema.String,
  marketId: Schema.String,
  outcome: Schema.Literal("A", "B"),
  shareAmount: Schema.Number,
  status: Schema.Literal("accepted"),
})

const MarketIdPath = Schema.Struct({
  marketId: Schema.String,
})

export class TradingGroup extends HttpApiGroup.make("trading")
  .add(
    HttpApiEndpoint.post("buyPreview", "/markets/:marketId/buy/preview")
      .setPath(MarketIdPath)
      .setPayload(TradePayload)
      .addSuccess(BuyPreviewResponse)
      .addError(MarketNotFound)
      .addError(MarketClosed)
      .addError(MarketAlreadyResolved)
      .addError(InvalidAmount)
      .addError(InvalidOutcome)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("sellPreview", "/markets/:marketId/sell/preview")
      .setPath(MarketIdPath)
      .setPayload(TradePayload)
      .addSuccess(SellPreviewResponse)
      .addError(MarketNotFound)
      .addError(MarketClosed)
      .addError(MarketAlreadyResolved)
      .addError(InvalidAmount)
      .addError(InvalidOutcome)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("buy", "/markets/:marketId/buy")
      .setPath(MarketIdPath)
      .setPayload(TradePayload)
      .addSuccess(BuyResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(MarketNotFound)
      .addError(MarketClosed)
      .addError(MarketAlreadyResolved)
      .addError(InvalidAmount)
      .addError(InvalidOutcome)
      .addError(InsufficientBalance)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("sell", "/markets/:marketId/sell")
      .setPath(MarketIdPath)
      .setPayload(TradePayload)
      .addSuccess(SellResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(MarketNotFound)
      .addError(MarketClosed)
      .addError(MarketAlreadyResolved)
      .addError(InvalidAmount)
      .addError(InvalidOutcome)
      .addError(InsufficientShares)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .middleware(AuthMiddleware)
{}
