import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Unauthorized } from "../errors"

export class EventsGroup extends HttpApiGroup.make("events")
  .add(
    HttpApiEndpoint.get("stream", "/events/stream")
      .setUrlParams(
        Schema.Struct({
          token: Schema.optional(Schema.String),
          lastEventId: Schema.optional(Schema.String),
        }),
      )
      .addSuccess(Schema.Unknown)
      .addError(Unauthorized)
  )
{}
