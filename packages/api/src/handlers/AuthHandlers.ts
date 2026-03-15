import { Effect, Layer, Redacted } from "effect"
import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server"
import { timingSafeEqual } from "node:crypto"
import { WpmApi } from "../Api"
import { AppConfigService } from "../Config"
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
import { DatabaseService } from "../services/DatabaseService"
import { AuthService, REFRESH_COOKIE_NAME, REFRESH_TTL_SECONDS } from "../services/AuthService"
import { WalletService } from "../services/WalletService"
import { NodeClientService } from "../services/NodeClient"

const CHALLENGE_TTL_MS = 60_000

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export const AuthHandlersLive = HttpApiBuilder.group(WpmApi, "auth", (handlers) =>
  Effect.gen(function*() {
    const config = yield* AppConfigService
    const db = yield* DatabaseService
    const auth = yield* AuthService
    const wallet = yield* WalletService
    const node = yield* NodeClientService

    return handlers
      .handle("registerBegin", ({ payload }) =>
        Effect.gen(function*() {
          const { inviteCode, name, email } = payload

          if (!isValidEmail(email)) {
            return yield* Effect.fail(
              new InvalidInviteCode({ message: "Invalid email format" }),
            )
          }

          const code = yield* db.findActiveInviteCode(inviteCode)
          if (!code) {
            return yield* Effect.fail(
              new InvalidInviteCode({ message: "Invalid or exhausted invite code" }),
            )
          }

          const existing = yield* db.findUserByEmail(email)
          if (existing) {
            return yield* Effect.fail(
              new DuplicateRegistration({ message: "Email already registered" }),
            )
          }

          const userId = crypto.randomUUID()

          const options = yield* Effect.tryPromise(() =>
            generateRegistrationOptions({
              rpName: config.webauthnRpName,
              rpID: config.webauthnRpId,
              userName: email,
              userDisplayName: name,
              userID: new TextEncoder().encode(userId),
              attestationType: "none",
              authenticatorSelection: {
                residentKey: "required",
                userVerification: "required",
              },
              timeout: 60000,
              supportedAlgorithmIDs: [-7, -257],
            }),
          ).pipe(Effect.orDie)

          const challengeId = crypto.randomUUID()
          yield* db.insertChallenge({
            id: challengeId,
            challenge: options.challenge,
            type: "webauthn_register",
            userData: JSON.stringify({ userId, name, email, inviteCode }),
            expiresAt: Date.now() + CHALLENGE_TTL_MS,
          })

          return { challengeId, publicKey: options as unknown }
        }),
      )
      .handle("registerComplete", ({ payload }) =>
        Effect.gen(function*() {
          const { challengeId, credential } = payload

          const challenge = yield* db.findChallenge(challengeId)
          if (!challenge || challenge.type !== "webauthn_register") {
            return yield* Effect.fail(
              new ChallengeExpired({ message: "Authentication challenge has expired" }),
            )
          }

          if (Date.now() > challenge.expires_at) {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new ChallengeExpired({ message: "Authentication challenge has expired" }),
            )
          }

          const userData = JSON.parse(challenge.user_data!) as {
            userId: string
            name: string
            email: string
            inviteCode: string
          }

          const verification = yield* Effect.tryPromise(() =>
            verifyRegistrationResponse({
              response: credential as Parameters<typeof verifyRegistrationResponse>[0]["response"],
              expectedChallenge: challenge.challenge,
              expectedOrigin: config.webauthnOrigin,
              expectedRPID: config.webauthnRpId,
              requireUserVerification: true,
            }),
          ).pipe(
            Effect.catchAll(() => {
              return db.deleteChallenge(challengeId).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new WebAuthnFailed({ message: "WebAuthn verification failed" }),
                  ),
                ),
              )
            }),
          )

          if (!verification.verified || !verification.registrationInfo) {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new WebAuthnFailed({ message: "WebAuthn verification failed" }),
            )
          }

          const { credential: regCredential } = verification.registrationInfo
          const keyPair = yield* wallet.generateKeyPair()
          const encryptedPrivateKey = yield* wallet.encryptPrivateKey(keyPair.privateKey)

          // Re-validate invite code
          const inviteCode = yield* db.findActiveInviteCode(userData.inviteCode)
          if (!inviteCode) {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new InvalidInviteCode({ message: "Invalid or exhausted invite code" }),
            )
          }

          // Re-check email uniqueness
          const existingUser = yield* db.findUserByEmail(userData.email)
          if (existingUser) {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new DuplicateRegistration({ message: "Email already registered" }),
            )
          }

          yield* db.insertUser({
            id: userData.userId,
            name: userData.name,
            email: userData.email,
            walletAddress: keyPair.publicKey,
            walletPrivateKeyEnc: encryptedPrivateKey,
          })

          yield* db.insertCredential({
            credentialId: regCredential.id,
            userId: userData.userId,
            publicKey: Buffer.from(regCredential.publicKey),
            counter: regCredential.counter,
          })

          yield* db.incrementInviteCodeUse(userData.inviteCode)
          yield* db.deleteChallenge(challengeId)

          // Airdrop 100,000 WPM
          yield* node.distribute(keyPair.publicKey, 100_000, "signup_airdrop").pipe(
            Effect.catchAll(() => Effect.void),
          )

          // Referral reward
          if (inviteCode.referrer) {
            yield* node.referralReward(inviteCode.referrer, userData.userId).pipe(
              Effect.catchAll(() => Effect.void),
            )
          }

          const token = yield* auth.signJwt({
            sub: userData.userId,
            role: "user",
            walletAddress: keyPair.publicKey,
            email: userData.email,
          })

          const refreshToken = yield* auth.signRefreshToken(userData.userId)

          // Set refresh cookie via raw response manipulation
          return yield* Effect.map(
            Effect.succeed({
              userId: userData.userId,
              walletAddress: keyPair.publicKey,
              token,
            }),
            (body) => body,
          )
        }),
      )
      .handle("loginBegin", () =>
        Effect.gen(function*() {
          const options = yield* Effect.tryPromise(() =>
            generateAuthenticationOptions({
              rpID: config.webauthnRpId,
              userVerification: "required",
              timeout: 60000,
            }),
          ).pipe(Effect.orDie)

          const challengeId = crypto.randomUUID()
          yield* db.insertChallenge({
            id: challengeId,
            challenge: options.challenge,
            type: "webauthn_login",
            expiresAt: Date.now() + CHALLENGE_TTL_MS,
          })

          return { challengeId, publicKey: options as unknown }
        }),
      )
      .handle("loginComplete", ({ payload }) =>
        Effect.gen(function*() {
          const { challengeId, credential } = payload

          const challenge = yield* db.findChallenge(challengeId)
          if (!challenge || challenge.type !== "webauthn_login") {
            return yield* Effect.fail(
              new Unauthorized({ message: "Invalid or expired challenge" }),
            )
          }

          if (Date.now() > challenge.expires_at) {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new ChallengeExpired({ message: "Authentication challenge has expired" }),
            )
          }

          const cred = credential as { id?: string; rawId?: string; type?: string; response?: unknown }
          if (!cred || typeof cred.id !== "string") {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new Unauthorized({ message: "Missing credential ID" }),
            )
          }

          const storedCredential = yield* db.findCredentialById(cred.id)
          if (!storedCredential) {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new Unauthorized({ message: "Unknown credential" }),
            )
          }

          const verification = yield* Effect.tryPromise(() =>
            verifyAuthenticationResponse({
              response: credential as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
              expectedChallenge: challenge.challenge,
              expectedOrigin: config.webauthnOrigin,
              expectedRPID: config.webauthnRpId,
              requireUserVerification: true,
              credential: {
                id: storedCredential.credential_id,
                publicKey: new Uint8Array(storedCredential.public_key),
                counter: storedCredential.counter,
              },
            }),
          ).pipe(
            Effect.catchAll(() => {
              return db.deleteChallenge(challengeId).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new Unauthorized({ message: "Authentication verification failed" }),
                  ),
                ),
              )
            }),
          )

          if (!verification.verified) {
            yield* db.deleteChallenge(challengeId)
            return yield* Effect.fail(
              new Unauthorized({ message: "Authentication verification failed" }),
            )
          }

          yield* db.updateCredentialCounter(
            storedCredential.credential_id,
            verification.authenticationInfo.newCounter,
          )
          yield* db.deleteChallenge(challengeId)

          const user = yield* db.findUserById(storedCredential.user_id)
          if (!user) {
            return yield* Effect.fail(
              new Unauthorized({ message: "User not found" }),
            )
          }

          const token = yield* auth.signJwt({
            sub: user.id,
            role: user.role as "user" | "admin",
            walletAddress: user.wallet_address,
            email: user.email,
          })

          return {
            userId: user.id,
            walletAddress: user.wallet_address,
            token,
          }
        }),
      )
      .handle("refresh", ({ request }) =>
        Effect.gen(function*() {
          // Parse refresh cookie from request headers
          const cookieHeader = request.headers["cookie"] ?? ""
          const cookies = Object.fromEntries(
            cookieHeader.split(";").map((c) => {
              const [k, ...v] = c.trim().split("=")
              return [k, v.join("=")]
            }),
          )
          const refreshToken = cookies[REFRESH_COOKIE_NAME]

          if (!refreshToken) {
            return yield* Effect.fail(
              new Unauthorized({
                message: "Refresh token expired or missing. Please re-authenticate.",
              }),
            )
          }

          const payload = yield* auth.verifyRefreshToken(refreshToken).pipe(
            Effect.catchAll(() =>
              Effect.fail(
                new Unauthorized({
                  message: "Refresh token expired or missing. Please re-authenticate.",
                }),
              ),
            ),
          )

          const user = yield* db.findUserById(payload.sub)
          if (!user) {
            return yield* Effect.fail(
              new Unauthorized({
                message: "Refresh token expired or missing. Please re-authenticate.",
              }),
            )
          }

          const token = yield* auth.signJwt({
            sub: user.id,
            role: user.role as "user" | "admin",
            walletAddress: user.wallet_address,
            email: user.email,
          })

          return { token }
        }),
      )
      .handle("adminLogin", ({ payload }) =>
        Effect.gen(function*() {
          const adminApiKey = config.adminApiKey
          if (!adminApiKey) {
            return yield* Effect.fail(
              new InternalError({ message: "Admin API key not configured" }),
            )
          }

          const a = Buffer.from(payload.apiKey)
          const b = Buffer.from(Redacted.value(adminApiKey))

          if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
            return yield* Effect.fail(
              new Forbidden({ message: "Insufficient permissions" }),
            )
          }

          const now = Math.floor(Date.now() / 1000)
          const token = yield* auth.signJwt({
            sub: "admin",
            role: "admin",
            exp: now + 24 * 60 * 60,
          })

          return { token }
        }),
      )
  }),
)
