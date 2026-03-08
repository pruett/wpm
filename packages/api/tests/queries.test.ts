import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { openDatabase } from "../src/db/index";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";
import {
  findUserById,
  findUserByEmail,
  findUserByWallet,
  insertUser,
  findCredentialById,
  insertCredential,
  updateCredentialCounter,
  findActiveInviteCode,
  incrementInviteCodeUse,
  insertChallenge,
  findChallenge,
  deleteChallenge,
  deleteExpiredChallenges,
} from "../src/db/queries";

let db: Database;
let path: string;

function setup(): void {
  path = join(tmpdir(), `wpm-queries-test-${randomUUID()}.db`);
  db = openDatabase(path);
}

function cleanup(): void {
  if (db) {
    db.close();
    try {
      unlinkSync(path);
    } catch {}
    try {
      unlinkSync(path + "-wal");
    } catch {}
    try {
      unlinkSync(path + "-shm");
    } catch {}
  }
}

function seedUser(id = "u1", email = "alice@test.com", wallet = "wallet1"): void {
  insertUser(
    {
      id,
      name: "Alice",
      email,
      walletAddress: wallet,
      walletPrivateKeyEnc: Buffer.from("encrypted-key"),
    },
    db,
  );
}

describe("db/queries — users", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("insertUser + findUserById round-trip", () => {
    seedUser();
    const user = findUserById("u1", db);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("u1");
    expect(user!.name).toBe("Alice");
    expect(user!.email).toBe("alice@test.com");
    expect(user!.wallet_address).toBe("wallet1");
    expect(user!.role).toBe("user");
    expect(user!.created_at).toBeGreaterThan(0);
  });

  test("findUserById returns null for unknown id", () => {
    expect(findUserById("nonexistent", db)).toBeNull();
  });

  test("findUserByEmail is case-insensitive", () => {
    seedUser();
    expect(findUserByEmail("ALICE@TEST.COM", db)).not.toBeNull();
    expect(findUserByEmail("alice@test.com", db)).not.toBeNull();
  });

  test("findUserByEmail returns null for unknown email", () => {
    expect(findUserByEmail("nobody@test.com", db)).toBeNull();
  });

  test("findUserByWallet returns matching user", () => {
    seedUser();
    const user = findUserByWallet("wallet1", db);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("u1");
  });

  test("findUserByWallet returns null for unknown address", () => {
    expect(findUserByWallet("nonexistent", db)).toBeNull();
  });

  test("insertUser with custom role", () => {
    insertUser(
      {
        id: "admin1",
        name: "Admin",
        email: "admin@test.com",
        walletAddress: "admin-wallet",
        walletPrivateKeyEnc: Buffer.from("enc"),
        role: "admin",
      },
      db,
    );
    const user = findUserById("admin1", db);
    expect(user!.role).toBe("admin");
  });

  test("insertUser rejects duplicate email", () => {
    seedUser();
    expect(() =>
      insertUser(
        {
          id: "u2",
          name: "Bob",
          email: "alice@test.com",
          walletAddress: "wallet2",
          walletPrivateKeyEnc: Buffer.from("enc"),
        },
        db,
      ),
    ).toThrow();
  });
});

describe("db/queries — webauthn credentials", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("insertCredential + findCredentialById round-trip", () => {
    seedUser();
    insertCredential(
      {
        credentialId: "cred1",
        userId: "u1",
        publicKey: Buffer.from("pub-key-data"),
      },
      db,
    );
    const cred = findCredentialById("cred1", db);
    expect(cred).not.toBeNull();
    expect(cred!.credential_id).toBe("cred1");
    expect(cred!.user_id).toBe("u1");
    expect(cred!.counter).toBe(0);
    expect(cred!.created_at).toBeGreaterThan(0);
  });

  test("findCredentialById returns null for unknown id", () => {
    expect(findCredentialById("nonexistent", db)).toBeNull();
  });

  test("updateCredentialCounter updates the counter", () => {
    seedUser();
    insertCredential({ credentialId: "cred1", userId: "u1", publicKey: Buffer.from("pk") }, db);
    updateCredentialCounter("cred1", 5, db);
    const cred = findCredentialById("cred1", db);
    expect(cred!.counter).toBe(5);
  });

  test("insertCredential with custom counter", () => {
    seedUser();
    insertCredential(
      { credentialId: "cred1", userId: "u1", publicKey: Buffer.from("pk"), counter: 42 },
      db,
    );
    const cred = findCredentialById("cred1", db);
    expect(cred!.counter).toBe(42);
  });
});

describe("db/queries — invite codes", () => {
  beforeEach(setup);
  afterEach(cleanup);

  function seedCode(
    code = "ABCD1234",
    maxUses = 10,
    useCount = 0,
    active = 1,
    referrer: string | null = null,
  ): void {
    db.query(
      "INSERT INTO invite_codes (code, created_by, referrer, max_uses, use_count, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(code, "admin", referrer, maxUses, useCount, active, Date.now());
  }

  test("findActiveInviteCode returns valid code", () => {
    seedCode();
    const code = findActiveInviteCode("ABCD1234", db);
    expect(code).not.toBeNull();
    expect(code!.code).toBe("ABCD1234");
  });

  test("findActiveInviteCode returns null for inactive code", () => {
    seedCode("INACTIVE", 10, 0, 0);
    expect(findActiveInviteCode("INACTIVE", db)).toBeNull();
  });

  test("findActiveInviteCode returns null for exhausted code", () => {
    seedCode("MAXED", 5, 5);
    expect(findActiveInviteCode("MAXED", db)).toBeNull();
  });

  test("findActiveInviteCode returns null for unknown code", () => {
    expect(findActiveInviteCode("NOPE", db)).toBeNull();
  });

  test("incrementInviteCodeUse increments use_count", () => {
    seedCode();
    incrementInviteCodeUse("ABCD1234", db);
    const row = db.query("SELECT use_count FROM invite_codes WHERE code = ?").get("ABCD1234") as {
      use_count: number;
    };
    expect(row.use_count).toBe(1);
  });

  test("incrementInviteCodeUse twice reaches max and exhausts code", () => {
    seedCode("TWO", 2);
    incrementInviteCodeUse("TWO", db);
    incrementInviteCodeUse("TWO", db);
    expect(findActiveInviteCode("TWO", db)).toBeNull();
  });
});

describe("db/queries — auth challenges", () => {
  beforeEach(setup);
  afterEach(cleanup);

  test("insertChallenge + findChallenge round-trip", () => {
    const expiresAt = Date.now() + 60_000;
    insertChallenge(
      {
        id: "ch1",
        challenge: "random-bytes",
        type: "registration",
        userData: '{"email":"alice@test.com"}',
        expiresAt,
      },
      db,
    );
    const ch = findChallenge("ch1", db);
    expect(ch).not.toBeNull();
    expect(ch!.challenge).toBe("random-bytes");
    expect(ch!.type).toBe("registration");
    expect(ch!.user_data).toBe('{"email":"alice@test.com"}');
    expect(ch!.expires_at).toBe(expiresAt);
  });

  test("insertChallenge with null userData", () => {
    insertChallenge(
      { id: "ch2", challenge: "bytes", type: "login", expiresAt: Date.now() + 60_000 },
      db,
    );
    const ch = findChallenge("ch2", db);
    expect(ch!.user_data).toBeNull();
  });

  test("findChallenge returns null for unknown id", () => {
    expect(findChallenge("nonexistent", db)).toBeNull();
  });

  test("deleteChallenge removes the challenge", () => {
    insertChallenge(
      { id: "ch1", challenge: "bytes", type: "login", expiresAt: Date.now() + 60_000 },
      db,
    );
    deleteChallenge("ch1", db);
    expect(findChallenge("ch1", db)).toBeNull();
  });

  test("deleteExpiredChallenges removes only expired entries", () => {
    const now = Date.now();
    insertChallenge({ id: "expired1", challenge: "a", type: "login", expiresAt: now - 1000 }, db);
    insertChallenge(
      { id: "expired2", challenge: "b", type: "registration", expiresAt: now - 500 },
      db,
    );
    insertChallenge({ id: "valid1", challenge: "c", type: "login", expiresAt: now + 60_000 }, db);

    const deleted = deleteExpiredChallenges(db);
    expect(deleted).toBe(2);
    expect(findChallenge("expired1", db)).toBeNull();
    expect(findChallenge("expired2", db)).toBeNull();
    expect(findChallenge("valid1", db)).not.toBeNull();
  });

  test("deleteExpiredChallenges returns 0 when nothing expired", () => {
    insertChallenge(
      { id: "valid", challenge: "c", type: "login", expiresAt: Date.now() + 60_000 },
      db,
    );
    expect(deleteExpiredChallenges(db)).toBe(0);
  });
});
