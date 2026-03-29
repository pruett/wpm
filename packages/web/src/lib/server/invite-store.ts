import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS invite_code (
    code        TEXT PRIMARY KEY,
    created_by  TEXT NOT NULL,
    invited_email TEXT NOT NULL,
    used_by     TEXT,
    used_at     TEXT,
    created_at  TEXT NOT NULL
  )
`);

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "WPM-";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function createInviteCode(createdBy: string, invitedEmail: string): string {
  const code = generateCode();
  db.prepare(
    `INSERT INTO invite_code (code, created_by, invited_email, created_at) VALUES (?, ?, ?, ?)`,
  ).run(code, createdBy, invitedEmail, new Date().toISOString());
  return code;
}

export function validateInviteCode(code: string): boolean {
  const row = db
    .prepare(`SELECT code FROM invite_code WHERE code = ? AND used_by IS NULL`)
    .get(code) as { code: string } | undefined;
  return !!row;
}

export function consumeInviteCode(code: string, email: string): void {
  db.prepare(
    `UPDATE invite_code SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL`,
  ).run(email, new Date().toISOString(), code);
}

export function listInviteCodes(
  createdBy: string,
): { code: string; invitedEmail: string; usedBy: string | null; createdAt: string }[] {
  return db
    .prepare(
      `SELECT code, invited_email as invitedEmail, used_by as usedBy, created_at as createdAt FROM invite_code WHERE created_by = ?`,
    )
    .all(createdBy) as {
    code: string;
    invitedEmail: string;
    usedBy: string | null;
    createdAt: string;
  }[];
}
