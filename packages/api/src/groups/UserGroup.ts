import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { AuthMiddleware } from "../middleware/AuthMiddleware"
import { Unauthorized, NodeUnavailable } from "../errors"

// --- Response schemas ---

const ProfileResponse = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  walletAddress: Schema.String,
  createdAt: Schema.Number,
})

const PositionsResponse = Schema.Struct({
  positions: Schema.Unknown,
})

const HistoryResponse = Schema.Struct({
  history: Schema.Unknown,
})

// --- Group ---

export class UserGroup extends HttpApiGroup.make("user")
  .add(
    HttpApiEndpoint.get("profile", "/user/profile")
      .addSuccess(ProfileResponse)
      .addError(Unauthorized)
  )
  .add(
    HttpApiEndpoint.get("positions", "/user/positions")
      .addSuccess(PositionsResponse)
      .addError(Unauthorized)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("history", "/user/history")
      .addSuccess(HistoryResponse)
      .addError(Unauthorized)
      .addError(NodeUnavailable)
  )
  .middleware(AuthMiddleware)
{}
