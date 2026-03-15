import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import {
  Unauthorized,
  InvalidInviteCode,
  DuplicateRegistration,
  ChallengeExpired,
  WebAuthnFailed,
  InternalError,
  Forbidden,
  NodeUnavailable,
} from "../errors"

// --- Request/Response schemas ---

const RegisterBeginPayload = Schema.Struct({
  inviteCode: Schema.String,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(50)),
  email: Schema.String,
})

const RegisterBeginResponse = Schema.Struct({
  challengeId: Schema.String,
  publicKey: Schema.Unknown,
})

const RegisterCompletePayload = Schema.Struct({
  challengeId: Schema.String,
  credential: Schema.Unknown,
})

const RegisterCompleteResponse = Schema.Struct({
  userId: Schema.String,
  walletAddress: Schema.String,
  token: Schema.String,
})

const LoginBeginResponse = Schema.Struct({
  challengeId: Schema.String,
  publicKey: Schema.Unknown,
})

const LoginCompletePayload = Schema.Struct({
  challengeId: Schema.String,
  credential: Schema.Unknown,
})

const LoginCompleteResponse = Schema.Struct({
  userId: Schema.String,
  walletAddress: Schema.String,
  token: Schema.String,
})

const RefreshResponse = Schema.Struct({
  token: Schema.String,
})

const AdminLoginPayload = Schema.Struct({
  apiKey: Schema.String,
})

const AdminLoginResponse = Schema.Struct({
  token: Schema.String,
})

// --- Group ---

export class AuthGroup extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("registerBegin", "/auth/register/begin")
      .setPayload(RegisterBeginPayload)
      .addSuccess(RegisterBeginResponse)
      .addError(InvalidInviteCode)
      .addError(DuplicateRegistration)
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.post("registerComplete", "/auth/register/complete")
      .setPayload(RegisterCompletePayload)
      .addSuccess(RegisterCompleteResponse, { status: 201 })
      .addError(ChallengeExpired)
      .addError(WebAuthnFailed)
      .addError(InvalidInviteCode)
      .addError(DuplicateRegistration)
      .addError(InternalError)
      .addError(NodeUnavailable)
  )
  .add(
    HttpApiEndpoint.post("loginBegin", "/auth/login/begin")
      .addSuccess(LoginBeginResponse)
      .addError(InternalError)
  )
  .add(
    HttpApiEndpoint.post("loginComplete", "/auth/login/complete")
      .setPayload(LoginCompletePayload)
      .addSuccess(LoginCompleteResponse)
      .addError(Unauthorized)
      .addError(ChallengeExpired)
  )
  .add(
    HttpApiEndpoint.post("refresh", "/auth/refresh")
      .addSuccess(RefreshResponse)
      .addError(Unauthorized)
  )
  .add(
    HttpApiEndpoint.post("adminLogin", "/auth/admin/login")
      .setPayload(AdminLoginPayload)
      .addSuccess(AdminLoginResponse)
      .addError(Forbidden)
      .addError(InternalError)
  )
{}
