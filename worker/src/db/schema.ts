import type { D1Database } from '@cloudflare/workers-types'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT 'Admin',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  keyword TEXT DEFAULT '',
  org TEXT DEFAULT '',
  lang TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  progress_scanned INTEGER NOT NULL DEFAULT 0,
  progress_skipped INTEGER NOT NULL DEFAULT 0,
  progress_findings INTEGER NOT NULL DEFAULT 0,
  limit_count INTEGER NOT NULL DEFAULT 30,
  min_entropy REAL NOT NULL DEFAULT 4.5,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS scan_runtime (
  scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  lock_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('critical', 'high', 'medium', 'low')),
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  matched_text TEXT NOT NULL,
  raw_text_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'unvalidated' CHECK(validation_status IN ('unvalidated', 'valid', 'invalid', 'error', 'unavailable')),
  validation_json TEXT,
  validated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scanned_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scan_id, file_key)
);

CREATE TABLE IF NOT EXISTS github_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  token_value TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_repo ON findings(repo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_rule ON findings(rule_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_validation ON findings(validation_status, scan_id);
CREATE INDEX IF NOT EXISTS idx_scanned_files_scan ON scanned_files(scan_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);
`

export async function ensureSchema(db: D1Database) {
  const statements = SCHEMA_SQL
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const stmt of statements) {
    await db.prepare(stmt).run()
  }
}
