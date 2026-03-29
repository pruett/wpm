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

const insertStmt = db.prepare(
  `INSERT INTO invite_code (code, created_by, invited_email, created_at) VALUES (?, ?, ?, ?)`,
);
const validateStmt = db.prepare(`SELECT code FROM invite_code WHERE code = ? AND used_by IS NULL`);
const consumeStmt = db.prepare(
  `UPDATE invite_code SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL`,
);
const listStmt = db.prepare(
  `SELECT code, invited_email as invitedEmail, used_by as usedBy, created_at as createdAt FROM invite_code WHERE created_by = ?`,
);

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
  insertStmt.run(code, createdBy, invitedEmail, new Date().toISOString());
  return code;
}

export function validateInviteCode(code: string): boolean {
  return !!validateStmt.get(code);
}

export function consumeInviteCode(code: string, email: string): boolean {
  const result = consumeStmt.run(email, new Date().toISOString(), code);
  return result.changes === 1;
}

export function listInviteCodes(
  createdBy: string,
): { code: string; invitedEmail: string; usedBy: string | null; createdAt: string }[] {
  return listStmt.all(createdBy) as {
    code: string;
    invitedEmail: string;
    usedBy: string | null;
    createdAt: string;
  }[];
}
