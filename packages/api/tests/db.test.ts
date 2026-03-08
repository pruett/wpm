import { describe, test, expect, afterEach } from "bun:test";
import { openDatabase } from "../src/db/index";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { unlinkSync } from "fs";

function tmpDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `wpm-test-${randomUUID()}.db`);
  const db = openDatabase(path);
  return { db, path };
}

function cleanup(db: Database, path: string): void {
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

describe("db/index", () => {
  let db: Database;
  let path: string;

  afterEach(() => {
    if (db) cleanup(db, path);
  });

  test("opens database in WAL mode", () => {
    ({ db, path } = tmpDb());
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  test("enables foreign keys", () => {
    ({ db, path } = tmpDb());
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  test("creates users table with correct columns", () => {
    ({ db, path } = tmpDb());
    const columns = db.query("PRAGMA table_info(users)").all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }[];

    const colMap = new Map(columns.map((c) => [c.name, c]));

    expect(colMap.get("id")!.pk).toBe(1);
    expect(colMap.get("id")!.type).toBe("TEXT");

    expect(colMap.get("name")!.notnull).toBe(1);
    expect(colMap.get("email")!.notnull).toBe(1);
    expect(colMap.get("wallet_address")!.notnull).toBe(1);
    expect(colMap.get("wallet_private_key_enc")!.notnull).toBe(1);

    expect(colMap.get("role")!.dflt_value).toBe("'user'");
    expect(colMap.get("created_at")!.type).toBe("INTEGER");
  });

  test("email is case-insensitive unique", () => {
    ({ db, path } = tmpDb());
    const insert = db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    insert.run("u1", "Alice", "alice@test.com", "wallet1", Buffer.from("enc1"), "user", Date.now());

    expect(() =>
      insert.run(
        "u2",
        "Alice2",
        "ALICE@test.com",
        "wallet2",
        Buffer.from("enc2"),
        "user",
        Date.now(),
      ),
    ).toThrow();
  });

  test("wallet_address is unique", () => {
    ({ db, path } = tmpDb());
    const insert = db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    insert.run("u1", "Alice", "a@test.com", "wallet1", Buffer.from("enc1"), "user", Date.now());

    expect(() =>
      insert.run("u2", "Bob", "b@test.com", "wallet1", Buffer.from("enc2"), "user", Date.now()),
    ).toThrow();
  });

  test("insert and query a user", () => {
    ({ db, path } = tmpDb());
    const now = Date.now();

    db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("u1", "Kevin", "kevin@test.com", "walletAddr", Buffer.from("encrypted-key"), "user", now);

    const user = db.query("SELECT * FROM users WHERE id = ?").get("u1") as {
      id: string;
      name: string;
      email: string;
      wallet_address: string;
      wallet_private_key_enc: Buffer;
      role: string;
      created_at: number;
    };

    expect(user.id).toBe("u1");
    expect(user.name).toBe("Kevin");
    expect(user.email).toBe("kevin@test.com");
    expect(user.wallet_address).toBe("walletAddr");
    expect(user.role).toBe("user");
    expect(user.created_at).toBe(now);
  });

  test("creates webauthn_credentials table with correct columns", () => {
    ({ db, path } = tmpDb());
    const columns = db.query("PRAGMA table_info(webauthn_credentials)").all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }[];

    const colMap = new Map(columns.map((c) => [c.name, c]));

    expect(colMap.get("credential_id")!.pk).toBe(1);
    expect(colMap.get("credential_id")!.type).toBe("TEXT");

    expect(colMap.get("user_id")!.notnull).toBe(1);
    expect(colMap.get("public_key")!.type).toBe("BLOB");
    expect(colMap.get("public_key")!.notnull).toBe(1);

    expect(colMap.get("counter")!.type).toBe("INTEGER");
    expect(colMap.get("counter")!.notnull).toBe(1);
    expect(colMap.get("counter")!.dflt_value).toBe("0");

    expect(colMap.get("created_at")!.type).toBe("INTEGER");
    expect(colMap.get("created_at")!.notnull).toBe(1);
  });

  test("webauthn_credentials enforces user_id FK", () => {
    ({ db, path } = tmpDb());

    // Insert credential referencing non-existent user should fail
    expect(() =>
      db
        .query(
          "INSERT INTO webauthn_credentials (credential_id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("cred1", "nonexistent-user", Buffer.from("pubkey"), 0, Date.now()),
    ).toThrow();
  });

  test("webauthn_credentials allows valid insert with existing user", () => {
    ({ db, path } = tmpDb());
    const now = Date.now();

    db.query(
      "INSERT INTO users (id, name, email, wallet_address, wallet_private_key_enc, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("u1", "Alice", "alice@test.com", "wallet1", Buffer.from("enc1"), "user", now);

    db.query(
      "INSERT INTO webauthn_credentials (credential_id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("cred1", "u1", Buffer.from("pubkey-data"), 0, now);

    const cred = db
      .query("SELECT * FROM webauthn_credentials WHERE credential_id = ?")
      .get("cred1") as {
      credential_id: string;
      user_id: string;
      public_key: Buffer;
      counter: number;
      created_at: number;
    };

    expect(cred.credential_id).toBe("cred1");
    expect(cred.user_id).toBe("u1");
    expect(cred.counter).toBe(0);
    expect(cred.created_at).toBe(now);
  });

  test("migrate is idempotent", () => {
    ({ db, path } = tmpDb());
    // openDatabase already ran migrate once; opening again should not throw
    const db2 = openDatabase(path);
    db2.close();
  });
});
