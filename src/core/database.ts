import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class RelayDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }

    this.raw = new DatabaseSync(path);
    this.raw.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        default_model TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('draft', 'active', 'paused', 'completed', 'failed', 'cancelled')
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        model TEXT NOT NULL,
        role TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'lost', 'left', 'revoked')),
        token_jti TEXT NOT NULL UNIQUE,
        joined_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        recovery_from_session_id TEXT REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS sessions_mission_status_idx
        ON sessions(mission_id, status);
      CREATE INDEX IF NOT EXISTS sessions_heartbeat_idx
        ON sessions(status, last_heartbeat_at);

      CREATE TABLE IF NOT EXISTS connection_tickets (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        token_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        role TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS connection_tickets_expiry_idx
        ON connection_tickets(status, expires_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        parent_task_id TEXT REFERENCES tasks(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'leased', 'running', 'completed', 'failed', 'cancelled')
        ),
        priority INTEGER NOT NULL DEFAULT 0,
        requirements_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        assigned_role TEXT,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        attempt INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT
      );

      CREATE INDEX IF NOT EXISTS tasks_queue_idx
        ON tasks(mission_id, status, priority DESC, created_at ASC);

      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        fencing_token INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('active', 'expired', 'released', 'completed')
        ),
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS leases_active_task_idx
        ON leases(task_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS leases_expiry_idx
        ON leases(status, expires_at);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        lease_id TEXT NOT NULL REFERENCES leases(id),
        summary TEXT NOT NULL,
        next_action TEXT NOT NULL,
        decisions_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        opaque_state_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS checkpoints_task_idx
        ON checkpoints(task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        sender_session_id TEXT NOT NULL REFERENCES sessions(id),
        to_session_id TEXT REFERENCES sessions(id),
        to_role TEXT,
        intent TEXT NOT NULL CHECK (
          intent IN ('inform', 'request', 'response', 'challenge', 'decision', 'handoff', 'blocker')
        ),
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        correlation_id TEXT,
        reply_to_id TEXT REFERENCES messages(id),
        artifacts_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_mission_idx
        ON messages(mission_id, priority DESC, created_at ASC);

      CREATE TABLE IF NOT EXISTS message_acknowledgements (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        acknowledged_at TEXT NOT NULL,
        PRIMARY KEY (message_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id),
        creator_session_id TEXT NOT NULL REFERENCES sessions(id),
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS artifacts_mission_idx
        ON artifacts(mission_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS relay_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'agent', 'system')),
        actor_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS relay_events_mission_idx
        ON relay_events(mission_id, sequence);

      CREATE TABLE IF NOT EXISTS idempotency_records (
        actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        response_json TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, idempotency_key)
      );
    `);
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  getSetting(key: string): string | null {
    const row = this.raw
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.raw
      .prepare(
        `INSERT INTO settings(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) {
    return fallback;
  }
  return JSON.parse(value) as T;
}
