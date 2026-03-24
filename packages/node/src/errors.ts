import { Data } from "effect";

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly code: string;
  readonly message: string;
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly message: string;
}> {}
