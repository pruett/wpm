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

/** Catch AuthError and return 401 JSON. Catch NodeClientError and return 502 JSON. */
export const catchErrors = <A, R>(
  self: Effect.Effect<A, unknown, R>,
): Effect.Effect<
  A | import("@effect/platform").HttpServerResponse.HttpServerResponse,
  import("@effect/platform").HttpBody.HttpBodyError,
  R
> =>
  self.pipe(
    Effect.catchAll((e: any) => {
      if (e?._tag === "AuthError") {
        return HttpServerResponse.json({ error: e.message }, { status: 401 });
      }
      if (e?._tag === "NodeClientError") {
        return HttpServerResponse.json({ error: e.message }, { status: 502 });
      }
      return HttpServerResponse.json({ error: "Internal error" }, { status: 500 });
    }),
  );
