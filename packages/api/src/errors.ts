import { Data } from "effect";

export class NodeClientError extends Data.TaggedError("NodeClientError")<{
  readonly message: string;
}> {}
