import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type SigningAuthority } from "./crypto.js";
import { parseJson, type RelayDatabase } from "./database.js";
import type { RelayEvent } from "./types.js";

interface EventRow {
  sequence: number;
  id: string;
  mission_id: string | null;
  actor_type: "admin" | "agent" | "system";
  actor_id: string;
  type: string;
  payload_json: string;
  previous_hash: string;
  hash: string;
  signature: string;
  created_at: string;
}

export interface AppendEventInput {
  missionId: string | null;
  actorType: "admin" | "agent" | "system";
  actorId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  firstInvalidSequence: number | null;
  reason: string | null;
  headHash: string;
}

export class EventStore {
  constructor(
    private readonly database: RelayDatabase,
    private readonly signing: SigningAuthority,
  ) {}

  append(input: AppendEventInput): RelayEvent {
    const previous = this.database.raw
      .prepare(
        `SELECT hash FROM relay_events
         WHERE (mission_id = ? OR (mission_id IS NULL AND ? IS NULL))
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(input.missionId, input.missionId) as { hash: string } | undefined;

    const event = {
      id: randomUUID(),
      missionId: input.missionId,
      actorType: input.actorType,
      actorId: input.actorId,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    const previousHash = previous?.hash ?? "0".repeat(64);
    const hash = sha256(`${previousHash}:${canonicalJson(event)}`);
    const signature = this.signing.signDigest(hash);

    const result = this.database.raw
      .prepare(
        `INSERT INTO relay_events(
          id, mission_id, actor_type, actor_id, type, payload_json,
          previous_hash, hash, signature, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.missionId,
        event.actorType,
        event.actorId,
        event.type,
        canonicalJson(event.payload),
        previousHash,
        hash,
        signature,
        event.createdAt,
      );

    return {
      sequence: Number(result.lastInsertRowid),
      ...event,
      previousHash,
      hash,
      signature,
    };
  }

  list(missionId: string | null, limit = 500): RelayEvent[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM relay_events
         WHERE (mission_id = ? OR (mission_id IS NULL AND ? IS NULL))
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(missionId, missionId, limit) as unknown as EventRow[];

    return rows.map(mapEvent).reverse();
  }

  listRecent(limit = 500): RelayEvent[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM relay_events
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(limit) as unknown as EventRow[];

    return rows.map(mapEvent).reverse();
  }

  verify(missionId: string | null): ChainVerification {
    const events = this.list(missionId, 100_000);
    let previousHash = "0".repeat(64);

    for (const event of events) {
      if (event.previousHash !== previousHash) {
        return {
          valid: false,
          checked: events.indexOf(event),
          firstInvalidSequence: event.sequence,
          reason: "Previous hash does not match the chain head",
          headHash: previousHash,
        };
      }

      const canonicalEvent = {
        id: event.id,
        missionId: event.missionId,
        actorType: event.actorType,
        actorId: event.actorId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      };
      const expected = sha256(
        `${event.previousHash}:${canonicalJson(canonicalEvent)}`,
      );

      if (expected !== event.hash) {
        return {
          valid: false,
          checked: events.indexOf(event),
          firstInvalidSequence: event.sequence,
          reason: "Event payload hash is invalid",
          headHash: previousHash,
        };
      }

      if (!this.signing.verifyDigest(event.hash, event.signature)) {
        return {
          valid: false,
          checked: events.indexOf(event),
          firstInvalidSequence: event.sequence,
          reason: "Event signature is invalid",
          headHash: previousHash,
        };
      }
      previousHash = event.hash;
    }

    return {
      valid: true,
      checked: events.length,
      firstInvalidSequence: null,
      reason: null,
      headHash: previousHash,
    };
  }

  verifyAll(): ChainVerification {
    const rows = this.database.raw
      .prepare(
        `SELECT DISTINCT mission_id FROM relay_events
         ORDER BY mission_id`,
      )
      .all() as unknown as Array<{ mission_id: string | null }>;
    let checked = 0;
    const heads: Array<{ missionId: string | null; headHash: string }> = [];

    for (const row of rows) {
      const verification = this.verify(row.mission_id);
      if (!verification.valid) {
        return {
          ...verification,
          checked: checked + verification.checked,
          reason: `${
            row.mission_id === null ? "Authority" : `Mission ${row.mission_id}`
          } chain: ${verification.reason ?? "verification failed"}`,
        };
      }
      checked += verification.checked;
      heads.push({
        missionId: row.mission_id,
        headHash: verification.headHash,
      });
    }

    return {
      valid: true,
      checked,
      firstInvalidSequence: null,
      reason: null,
      headHash:
        heads.length === 0
          ? "0".repeat(64)
          : sha256(canonicalJson(heads)),
    };
  }
}

function mapEvent(row: EventRow): RelayEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    missionId: row.mission_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    type: row.type,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    previousHash: row.previous_hash,
    hash: row.hash,
    signature: row.signature,
    createdAt: row.created_at,
  };
}
