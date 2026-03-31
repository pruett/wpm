CREATE TABLE invite_code (
  code          TEXT PRIMARY KEY,
  created_by    TEXT NOT NULL,
  invited_email TEXT NOT NULL,
  used_by       TEXT,
  used_at       TEXT,
  created_at    TEXT NOT NULL
);
