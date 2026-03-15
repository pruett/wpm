import { Effect, Layer } from "effect"
import { SqlClient } from "@effect/sql"

// --- Row types ---

export type UserRow = {
  id: string
  name: string
  email: string
  wallet_address: string
  wallet_private_key_enc: Buffer
  role: string
  created_at: number
}

export type WebAuthnCredentialRow = {
  credential_id: string
  user_id: string
  public_key: Buffer
  counter: number
  created_at: number
}

export type InviteCodeRow = {
  code: string
  created_by: string
  referrer: string | null
  max_uses: number
  use_count: number
  active: number
  created_at: number
}

export type AuthChallengeRow = {
  id: string
  challenge: string
  type: string
  user_data: string | null
  expires_at: number
  created_at: number
}

// --- Service ---

export class DatabaseService extends Effect.Tag("DatabaseService")<
  DatabaseService,
  {
    readonly findUserById: (id: string) => Effect.Effect<UserRow | null>
    readonly findUserByEmail: (email: string) => Effect.Effect<UserRow | null>
    readonly findUserByWallet: (walletAddress: string) => Effect.Effect<UserRow | null>
    readonly insertUser: (user: {
      id: string
      name: string
      email: string
      walletAddress: string
      walletPrivateKeyEnc: Buffer
      role?: string
    }) => Effect.Effect<void>
    readonly getAllUsers: () => Effect.Effect<ReadonlyArray<UserRow>>
    readonly findCredentialById: (credentialId: string) => Effect.Effect<WebAuthnCredentialRow | null>
    readonly insertCredential: (credential: {
      credentialId: string
      userId: string
      publicKey: Buffer
      counter?: number
    }) => Effect.Effect<void>
    readonly updateCredentialCounter: (credentialId: string, counter: number) => Effect.Effect<void>
    readonly findActiveInviteCode: (code: string) => Effect.Effect<InviteCodeRow | null>
    readonly incrementInviteCodeUse: (code: string) => Effect.Effect<void>
    readonly insertInviteCode: (invite: {
      code: string
      createdBy: string
      referrer?: string | null
      maxUses: number
    }) => Effect.Effect<void>
    readonly getAllInviteCodes: () => Effect.Effect<ReadonlyArray<InviteCodeRow>>
    readonly findInviteCode: (code: string) => Effect.Effect<InviteCodeRow | null>
    readonly deactivateInviteCode: (code: string) => Effect.Effect<boolean>
    readonly insertChallenge: (challenge: {
      id: string
      challenge: string
      type: string
      userData?: string | null
      expiresAt: number
    }) => Effect.Effect<void>
    readonly findChallenge: (id: string) => Effect.Effect<AuthChallengeRow | null>
    readonly deleteChallenge: (id: string) => Effect.Effect<void>
    readonly deleteExpiredChallenges: () => Effect.Effect<number>
  }
>() {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient

      const q = <T>(query: Effect.Effect<ReadonlyArray<T>, any>): Effect.Effect<ReadonlyArray<T>> =>
        query.pipe(Effect.orDie)

      const qOne = <T>(query: Effect.Effect<ReadonlyArray<T>, any>): Effect.Effect<T | null> =>
        query.pipe(
          Effect.map((rows) => (rows.length > 0 ? rows[0] : null)),
          Effect.orDie,
        )

      const exec = (query: Effect.Effect<any, any>): Effect.Effect<void> =>
        query.pipe(Effect.asVoid, Effect.orDie)

      return {
        findUserById: (id) =>
          qOne(sql.unsafe<UserRow>("SELECT * FROM users WHERE id = ?", [id])),

        findUserByEmail: (email) =>
          qOne(sql.unsafe<UserRow>("SELECT * FROM users WHERE email = ?", [email])),

        findUserByWallet: (walletAddress) =>
          qOne(sql.unsafe<UserRow>("SELECT * FROM users WHERE wallet_address = ?", [walletAddress])),

        insertUser: (user) =>
          exec(
            sql.unsafe(
              "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [user.id, user.name, user.email, user.walletAddress, user.walletPrivateKeyEnc, user.role ?? "user", Date.now()],
            ),
          ),

        getAllUsers: () =>
          q(sql.unsafe<UserRow>("SELECT * FROM users ORDER BY created_at ASC")),

        findCredentialById: (credentialId) =>
          qOne(sql.unsafe<WebAuthnCredentialRow>("SELECT * FROM webauthn_credentials WHERE credential_id = ?", [credentialId])),

        insertCredential: (credential) =>
          exec(
            sql.unsafe(
              "INSERT INTO webauthn_credentials (credential_id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?)",
              [credential.credentialId, credential.userId, credential.publicKey, credential.counter ?? 0, Date.now()],
            ),
          ),

        updateCredentialCounter: (credentialId, counter) =>
          exec(sql.unsafe("UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?", [counter, credentialId])),

        findActiveInviteCode: (code) =>
          qOne(sql.unsafe<InviteCodeRow>("SELECT * FROM invite_codes WHERE code = ? AND active = 1 AND use_count < max_uses", [code])),

        incrementInviteCodeUse: (code) =>
          exec(sql.unsafe("UPDATE invite_codes SET use_count = use_count + 1 WHERE code = ?", [code])),

        insertInviteCode: (invite) =>
          exec(
            sql.unsafe(
              "INSERT INTO invite_codes (code, created_by, referrer, max_uses, use_count, active, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)",
              [invite.code, invite.createdBy, invite.referrer ?? null, invite.maxUses, Date.now()],
            ),
          ),

        getAllInviteCodes: () =>
          q(sql.unsafe<InviteCodeRow>("SELECT * FROM invite_codes ORDER BY created_at DESC")),

        findInviteCode: (code) =>
          qOne(sql.unsafe<InviteCodeRow>("SELECT * FROM invite_codes WHERE code = ?", [code])),

        deactivateInviteCode: (code) =>
          sql.unsafe("UPDATE invite_codes SET active = 0 WHERE code = ? AND active = 1", [code]).pipe(
            Effect.map(() => true),
            Effect.orDie,
          ),

        insertChallenge: (challenge) =>
          exec(
            sql.unsafe(
              "INSERT INTO auth_challenges (id, challenge, type, user_data, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              [challenge.id, challenge.challenge, challenge.type, challenge.userData ?? null, challenge.expiresAt, Date.now()],
            ),
          ),

        findChallenge: (id) =>
          qOne(sql.unsafe<AuthChallengeRow>("SELECT * FROM auth_challenges WHERE id = ?", [id])),

        deleteChallenge: (id) =>
          exec(sql.unsafe("DELETE FROM auth_challenges WHERE id = ?", [id])),

        deleteExpiredChallenges: () =>
          sql.unsafe("DELETE FROM auth_challenges WHERE expires_at <= ?", [Date.now()]).pipe(
            Effect.map(() => 0),
            Effect.orDie,
          ),
      }
    }),
  )
}
