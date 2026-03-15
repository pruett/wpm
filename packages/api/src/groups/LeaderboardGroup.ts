import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { AuthMiddleware } from "../middleware/AuthMiddleware"
import { NodeUnavailable } from "../errors"

// --- Response schemas ---

const AlltimeResponse = Schema.Struct({
  rankings: Schema.Unknown,
})

const WeeklyResponse = Schema.Struct({
  rankings: Schema.Unknown,
  weekStart: Schema.Number,
})

// --- Group ---

export class LeaderboardGroup extends HttpApiGroup.make("leaderboard")
  .add(
    HttpApiEndpoint.get("alltime", "/leaderboard/alltime")
      .addSuccess(AlltimeResponse)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.get("weekly", "/leaderboard/weekly")
      .addSuccess(WeeklyResponse)
      .addError(NodeUnavailable)
  )
  .middleware(AuthMiddleware)
{}
