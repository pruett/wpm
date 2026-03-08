import type { Database } from "bun:sqlite";
import { getDb } from "./index";

// --- Row types ---

export type UserRow = {
  id: string;
  name: string;
  email: string;
  wallet_address: string;
  wallet_private_key_enc: Buffer;
  role: string;
  created_at: number;
};

export type WebAuthnCredentialRow = {
  credential_id: string;
  user_id: string;
  public_key: Buffer;
  counter: number;
  created_at: number;
};

export type InviteCodeRow = {
  code: string;
  created_by: string;
  referrer: string | null;
  max_uses: number;
  use_count: number;
  active: number;
  created_at: number;
};

export type AuthChallengeRow = {
  id: string;
  challenge: string;
  type: string;
  user_data: string | null;
  expires_at: number;
  created_at: number;
};

// --- User queries ---

export function findUserById(id: string, db?: Database): UserRow | null {
  return (db ?? getDb()).query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null;
}

export function findUserByEmail(email: string, db?: Database): UserRow | null {
  return (db ?? getDb()).query("SELECT * FROM users WHERE email = ?").get(email) as UserRow | null;
}

export function findUserByWallet(walletAddress: string, db?: Database): UserRow | null {
  return (db ?? getDb())
    .query("SELECT * FROM users WHERE wallet_address = ?")
    .get(walletAddress) as UserRow | null;
}

export function insertUser(
  user: {
    id: string;
    name: string;
    email: string;
    walletAddress: string;
    walletPrivateKeyEnc: Buffer;
    role?: string;
  },
  db?: Database,
): void {
  (db ?? getDb())
    .query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      user.id,
      user.name,
      user.email,
      user.walletAddress,
      user.walletPrivateKeyEnc,
      user.role ?? "user",
      Date.now(),
    );
}

// --- WebAuthn credential queries ---

export function findCredentialById(
  credentialId: string,
  db?: Database,
): WebAuthnCredentialRow | null {
  return (db ?? getDb())
    .query("SELECT * FROM webauthn_credentials WHERE credential_id = ?")
    .get(credentialId) as WebAuthnCredentialRow | null;
}

export function insertCredential(
  credential: {
    credentialId: string;
    userId: string;
    publicKey: Buffer;
    counter?: number;
  },
  db?: Database,
): void {
  (db ?? getDb())
    .query(
      "INSERT INTO webauthn_credentials (credential_id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      credential.credentialId,
      credential.userId,
      credential.publicKey,
      credential.counter ?? 0,
      Date.now(),
    );
}

export function updateCredentialCounter(
  credentialId: string,
  counter: number,
  db?: Database,
): void {
  (db ?? getDb())
    .query("UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?")
    .run(counter, credentialId);
}

// --- Invite code queries ---

export function findActiveInviteCode(code: string, db?: Database): InviteCodeRow | null {
  return (db ?? getDb())
    .query("SELECT * FROM invite_codes WHERE code = ? AND active = 1 AND use_count < max_uses")
    .get(code) as InviteCodeRow | null;
}

export function incrementInviteCodeUse(code: string, db?: Database): void {
  (db ?? getDb())
    .query("UPDATE invite_codes SET use_count = use_count + 1 WHERE code = ?")
    .run(code);
}

// --- Auth challenge queries ---

export function insertChallenge(
  challenge: {
    id: string;
    challenge: string;
    type: string;
    userData?: string | null;
    expiresAt: number;
  },
  db?: Database,
): void {
  (db ?? getDb())
    .query(
      "INSERT INTO auth_challenges (id, challenge, type, user_data, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      challenge.id,
      challenge.challenge,
      challenge.type,
      challenge.userData ?? null,
      challenge.expiresAt,
      Date.now(),
    );
}

export function findChallenge(id: string, db?: Database): AuthChallengeRow | null {
  return (db ?? getDb())
    .query("SELECT * FROM auth_challenges WHERE id = ?")
    .get(id) as AuthChallengeRow | null;
}

export function deleteChallenge(id: string, db?: Database): void {
  (db ?? getDb()).query("DELETE FROM auth_challenges WHERE id = ?").run(id);
}

export function deleteExpiredChallenges(db?: Database): number {
  const result = (db ?? getDb())
    .query("DELETE FROM auth_challenges WHERE expires_at <= ?")
    .run(Date.now());
  return result.changes;
}
