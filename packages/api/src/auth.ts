import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Data, Effect } from "effect";
import { UserStore, type StoredUser } from "./user-store.js";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

/** Extract authenticated user from Bearer token, or fail with AuthError. */
export const authenticated: Effect.Effect<
  StoredUser,
  AuthError,
  UserStore | HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const authHeader = request.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return yield* new AuthError({ message: "Missing or invalid Authorization header" });
  }
  const token = authHeader.slice(7);
  const userStore = yield* UserStore;
  const user = userStore.getByToken(token);
  if (!user) {
    return yield* new AuthError({ message: "Invalid token" });
  }
  return user;
});

/** Catch AuthError and return 401 JSON response. */
export const catchAuth = Effect.catchTag("AuthError", (e: AuthError) =>
  HttpServerResponse.json({ error: e.message }, { status: 401 }),
);
