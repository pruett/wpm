import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Data, Effect } from "effect";
import { WalletKeystore, type WalletEntry } from "./wallet-keystore.js";

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

/** Extract authenticated wallet from Bearer token, or fail with AuthError. */
export const authenticated: Effect.Effect<
  WalletEntry,
  AuthError,
  WalletKeystore | HttpServerRequest.HttpServerRequest
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const authHeader = request.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return yield* new AuthError({ message: "Missing or invalid Authorization header" });
  }
  const token = authHeader.slice(7);
  const keystore = yield* WalletKeystore;
  const wallet = keystore.getByToken(token);
  if (!wallet) {
    return yield* new AuthError({ message: "Invalid token" });
  }
  return wallet;
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
