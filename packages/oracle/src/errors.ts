import { Data } from "effect";

export class OracleError extends Data.TaggedError("OracleError")<{
  readonly message: string;
}> {}
