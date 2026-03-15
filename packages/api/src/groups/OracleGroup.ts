import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import {
  Unauthorized,
  InternalError,
  NodeUnavailable,
} from "../errors"

// --- Request/Response schemas ---

const SubmitTransactionResponse = Schema.Struct({
  txId: Schema.String,
  status: Schema.Literal("accepted"),
})

const OracleMarketsUrlParams = Schema.Struct({
  status: Schema.optional(Schema.String),
})

const ListMarketsResponse = Schema.Struct({
  markets: Schema.Unknown,
})

// --- Group ---

export class OracleGroup extends HttpApiGroup.make("oracle")
  .prefix("/oracle")
  .add(
    HttpApiEndpoint.post("submitTransaction", "/transaction")
      .setPayload(Schema.Unknown)
      .addSuccess(SubmitTransactionResponse, { status: 202 })
      .addError(Unauthorized)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("listMarkets", "/markets")
      .setUrlParams(OracleMarketsUrlParams)
      .addSuccess(ListMarketsResponse)
      .addError(NodeUnavailable)
  )
{}
