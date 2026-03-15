import { Schema } from "effect"

// --- Shared domain schemas ---

export const Outcome = Schema.Literal("A", "B")
export type Outcome = typeof Outcome.Type

export const MarketId = Schema.String.pipe(Schema.brand("MarketId"))
export type MarketId = typeof MarketId.Type

export const Amount = Schema.Number.pipe(
  Schema.positive(),
  Schema.finite(),
  Schema.filter((n) => {
    const parts = n.toString().split(".")
    return !(parts[1] && parts[1].length > 2)
  }, { message: () => "Amount must have at most 2 decimal places" }),
)
export type Amount = typeof Amount.Type

export const Pagination = Schema.Struct({
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.between(1, 100))),
  offset: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
})
export type Pagination = typeof Pagination.Type

export const PaginationWide = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 200))),
  offset: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))),
})

export const MarketStatus = Schema.Literal("open", "resolved", "cancelled")
export type MarketStatus = typeof MarketStatus.Type

export const UserRole = Schema.Literal("user", "admin")
export type UserRole = typeof UserRole.Type

// --- Reusable response schemas ---

export const TxAccepted = Schema.Struct({
  txId: Schema.String,
  status: Schema.Literal("accepted"),
})

export const HealthResponse = Schema.Struct({
  status: Schema.String,
  uptimeMs: Schema.Number,
  nodeReachable: Schema.Boolean,
  node: Schema.optional(
    Schema.Struct({
      blockHeight: Schema.Number,
      mempoolSize: Schema.Number,
    }),
  ),
})

// --- Helper ---

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function clampPagination(
  params: { limit?: number | undefined; offset?: number | undefined },
  defaults: { limit: number; maxLimit: number } = { limit: 20, maxLimit: 100 },
): { limit: number; offset: number } {
  const limit = Math.min(
    defaults.maxLimit,
    Math.max(1, params.limit ?? defaults.limit),
  )
  const offset = Math.max(0, params.offset ?? 0)
  return { limit, offset }
}
