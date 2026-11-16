import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { sha256 } from "./hash.js";
import { isoNow } from "./time.js";

export interface AuditEntry {
  principal: string;
  action: string;
  subject: string;
  payload: unknown;
  at: Date;
}

/** Append-only. The application has no update or delete path. Triggers reject both. */
export function appendAudit(db: Db, entry: AuditEntry): void {
  const payload = stable(entry.payload);
  db.prepare(
    `INSERT INTO audit_event (id, at, principal, action, subject, payload_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    isoNow(entry.at),
    entry.principal,
    entry.action,
    entry.subject,
    sha256(payload),
  );
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue(record[key]);
        return acc;
      }, {});
  }
  return value;
}
