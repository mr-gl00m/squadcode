import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type AuditAction =
  | "session_started"
  | "session_resumed"
  | "user_prompt"
  | "tool_call"
  | "tool_result"
  | "permission_decision"
  | "session_archived";

export interface AuditAppendInput {
  sessionId: string;
  action: AuditAction;
  payload: unknown;
}

export interface AuditRow {
  id: number;
  ts: string;
  sessionId: string;
  action: AuditAction;
  payloadHash: string;
  prevHash: string | null;
}

interface RawRow {
  id: number;
  ts: string;
  session_id: string;
  action: string;
  payload_hash: string;
  prev_hash: string | null;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

function linkHash(payloadHash: string, prevHash: string | null): string {
  return sha256(`${payloadHash}|${prevHash ?? ""}`);
}

export class AuditChain {
  private readonly insertStmt: Database.Statement;
  private readonly fetchLastStmt: Database.Statement;
  private readonly fetchAllStmt: Database.Statement;
  private lastLink: string | null;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO audit_log (ts, session_id, action, payload_hash, prev_hash)
      VALUES (@ts, @session_id, @action, @payload_hash, @prev_hash)
    `);
    this.fetchLastStmt = db.prepare(
      "SELECT id, ts, session_id, action, payload_hash, prev_hash FROM audit_log ORDER BY id DESC LIMIT 1",
    );
    this.fetchAllStmt = db.prepare(
      "SELECT id, ts, session_id, action, payload_hash, prev_hash FROM audit_log ORDER BY id ASC",
    );
    const last = this.fetchLastStmt.get() as RawRow | undefined;
    this.lastLink = last ? linkHash(last.payload_hash, last.prev_hash) : null;
  }

  append(input: AuditAppendInput): void {
    const ts = new Date().toISOString();
    const payloadJson = JSON.stringify(input.payload);
    const payloadHash = sha256(payloadJson);
    const prevHash = this.lastLink;
    this.insertStmt.run({
      ts,
      session_id: input.sessionId,
      action: input.action,
      payload_hash: payloadHash,
      prev_hash: prevHash,
    });
    this.lastLink = linkHash(payloadHash, prevHash);
  }

  validate(): { ok: boolean; brokenAtId?: number; reason?: string } {
    const rows = this.fetchAllStmt.all() as RawRow[];
    let expectedPrev: string | null = null;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return {
          ok: false,
          brokenAtId: row.id,
          reason: `prev_hash mismatch at row ${row.id}: expected ${expectedPrev ?? "null"}, got ${row.prev_hash ?? "null"}`,
        };
      }
      expectedPrev = linkHash(row.payload_hash, row.prev_hash);
    }
    return { ok: true };
  }

  fetchAll(): AuditRow[] {
    const rows = this.fetchAllStmt.all() as RawRow[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      sessionId: r.session_id,
      action: r.action as AuditAction,
      payloadHash: r.payload_hash,
      prevHash: r.prev_hash,
    }));
  }
}
