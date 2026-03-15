import { Schema } from "effect"
import { HttpApiSchema } from "@effect/platform"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class MarketNotFound extends Schema.TaggedError<MarketNotFound>()(
  "MarketNotFound",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class RecipientNotFound extends Schema.TaggedError<RecipientNotFound>()(
  "RecipientNotFound",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class MarketClosed extends Schema.TaggedError<MarketClosed>()(
  "MarketClosed",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class MarketAlreadyResolved extends Schema.TaggedError<MarketAlreadyResolved>()(
  "MarketAlreadyResolved",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class MarketHasTrades extends Schema.TaggedError<MarketHasTrades>()(
  "MarketHasTrades",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class InsufficientBalance extends Schema.TaggedError<InsufficientBalance>()(
  "InsufficientBalance",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class InsufficientShares extends Schema.TaggedError<InsufficientShares>()(
  "InsufficientShares",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class InvalidAmount extends Schema.TaggedError<InvalidAmount>()(
  "InvalidAmount",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class InvalidOutcome extends Schema.TaggedError<InvalidOutcome>()(
  "InvalidOutcome",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class InvalidInviteCode extends Schema.TaggedError<InvalidInviteCode>()(
  "InvalidInviteCode",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class DuplicateRegistration extends Schema.TaggedError<DuplicateRegistration>()(
  "DuplicateRegistration",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 409 }),
) {}

export class ChallengeExpired extends Schema.TaggedError<ChallengeExpired>()(
  "ChallengeExpired",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class WebAuthnFailed extends Schema.TaggedError<WebAuthnFailed>()(
  "WebAuthnFailed",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class InvalidTransfer extends Schema.TaggedError<InvalidTransfer>()(
  "InvalidTransfer",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 429 }),
) {}

export class NodeUnavailable extends Schema.TaggedError<NodeUnavailable>()(
  "NodeUnavailable",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 503 }),
) {}

export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 500 }),
) {}
