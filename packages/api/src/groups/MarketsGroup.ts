import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { AuthMiddleware } from "../middleware/AuthMiddleware"
import { MarketNotFound, NodeUnavailable } from "../errors"

const MarketIdPath = Schema.Struct({
  marketId: Schema.String,
})

const ListOpenMarketsResponse = Schema.Struct({
  markets: Schema.Array(Schema.Unknown),
})

const ListResolvedMarketsResponse = Schema.Struct({
  markets: Schema.Array(Schema.Unknown),
  total: Schema.Number,
  limit: Schema.Number,
  offset: Schema.Number,
})

const ResolvedUrlParams = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100))),
  offset: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
})

const GetMarketResponse = Schema.Struct({
  market: Schema.Unknown,
  pool: Schema.Unknown,
  prices: Schema.Unknown,
  userPosition: Schema.Unknown,
})

const TradesUrlParams = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 100))),
  offset: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
})

const GetTradesResponse = Schema.Struct({
  trades: Schema.Array(Schema.Unknown),
  total: Schema.Number,
  limit: Schema.Number,
  offset: Schema.Number,
})

export class MarketsGroup extends HttpApiGroup.make("markets")
  .add(
    HttpApiEndpoint.get("listOpen", "/markets")
      .addSuccess(ListOpenMarketsResponse)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("listResolved", "/markets/resolved")
      .setUrlParams(ResolvedUrlParams)
      .addSuccess(ListResolvedMarketsResponse)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("getMarket", "/markets/:marketId")
      .setPath(MarketIdPath)
      .addSuccess(GetMarketResponse)
      .addError(MarketNotFound)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("getTrades", "/markets/:marketId/trades")
      .setPath(MarketIdPath)
      .setUrlParams(TradesUrlParams)
      .addSuccess(GetTradesResponse)
      .addError(MarketNotFound)
      .addError(NodeUnavailable)
  )
  .middleware(AuthMiddleware)
{}
