import { DatabaseSync } from "node:sqlite";

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      style TEXT NOT NULL CHECK (style = 'stylized'),
      runtime_floor_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      title_locked INTEGER NOT NULL DEFAULT 0,
      reliable_shot_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS actor (
      id TEXT PRIMARY KEY,
      legal_name TEXT NOT NULL,
      dob TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      method TEXT NOT NULL,
      reviewer TEXT NOT NULL,
      result TEXT NOT NULL,
      verified_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cast_slot (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      allow_violence INTEGER NOT NULL DEFAULT 0,
      allow_stunts INTEGER NOT NULL DEFAULT 0,
      allow_nudity INTEGER NOT NULL DEFAULT 0,
      voice_allowed INTEGER NOT NULL DEFAULT 0,
      consent_id TEXT,
      UNIQUE (project_id, slot_index)
    );

    CREATE TABLE IF NOT EXISTS consent (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      actor_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slot_id TEXT,
      allow_violence INTEGER NOT NULL DEFAULT 0,
      allow_stunts INTEGER NOT NULL DEFAULT 0,
      allow_nudity INTEGER NOT NULL DEFAULT 0,
      max_runtime_ms INTEGER NOT NULL,
      territories TEXT NOT NULL,
      term_start TEXT NOT NULL,
      term_end TEXT NOT NULL,
      allow_trailers INTEGER NOT NULL DEFAULT 0,
      allow_stills INTEGER NOT NULL DEFAULT 0,
      allow_marketing INTEGER NOT NULL DEFAULT 0,
      trailer_max_ms INTEGER NOT NULL DEFAULT 0,
      allow_voice INTEGER NOT NULL DEFAULT 0,
      allow_training INTEGER NOT NULL DEFAULT 0 CHECK (allow_training = 0),
      allow_sublicense INTEGER NOT NULL DEFAULT 0 CHECK (allow_sublicense = 0),
      require_likeness_approval INTEGER NOT NULL DEFAULT 0,
      likeness_approved_at TEXT,
      likeness_approved_by TEXT,
      document_ref TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      revoked_at TEXT,
      revocation_reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reference_pack (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      consent_id TEXT NOT NULL,
      phrase TEXT NOT NULL,
      status TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      destroyed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS short_story (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      submitter TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_package (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      short_story_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      block_reason TEXT,
      block_term TEXT,
      full_story TEXT,
      script TEXT,
      screenplay TEXT,
      dialogue_json TEXT,
      bible_json TEXT,
      characters_json TEXT,
      substitutions_json TEXT,
      model TEXT NOT NULL,
      hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS character_row (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scene (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      act INTEGER NOT NULL,
      location TEXT NOT NULL,
      time_of_day TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      want TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shot (
      id TEXT PRIMARY KEY,
      scene_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      camera TEXT NOT NULL,
      action TEXT NOT NULL,
      target_ms INTEGER NOT NULL,
      dialogue_id TEXT,
      continuity TEXT NOT NULL,
      slot_indexes TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS take (
      id TEXT PRIMARY KEY,
      shot_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      output_hash TEXT,
      reference_pack_ids TEXT NOT NULL,
      consent_ids TEXT NOT NULL,
      actor_ids TEXT NOT NULL,
      seed TEXT NOT NULL,
      clip_path TEXT,
      speech_path TEXT,
      duration_ms INTEGER NOT NULL,
      identity_token TEXT NOT NULL,
      identity_distance REAL,
      identity_method TEXT,
      reviewer TEXT,
      decision TEXT NOT NULL,
      usable INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cut (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      take_ids TEXT NOT NULL,
      picture_ms INTEGER NOT NULL,
      reviewer TEXT,
      decision TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS export_row (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      cut_id TEXT,
      status TEXT NOT NULL,
      blocked_reason TEXT,
      reasons_json TEXT NOT NULL,
      picture_ms INTEGER,
      consent_snapshot TEXT,
      disclosure TEXT,
      manifest_path TEXT,
      mix_path TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_event (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      principal TEXT NOT NULL,
      action TEXT NOT NULL,
      subject TEXT NOT NULL,
      payload_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calibration (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      model TEXT NOT NULL,
      measured_ms INTEGER NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      shot_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS audit_no_update
    BEFORE UPDATE ON audit_event
    BEGIN
      SELECT RAISE(ABORT, 'audit log is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_no_delete
    BEFORE DELETE ON audit_event
    BEGIN
      SELECT RAISE(ABORT, 'audit log is append-only');
    END;
  `);
}

export type Db = DatabaseSync;
