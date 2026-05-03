import type Database from "better-sqlite3";
import type { CreateSessionInput, ListFilter, SessionMetadata } from "./types.js";

interface Row {
  session_id: string;
  started_at: string;
  updated_at: string;
  cwd: string;
  provider: string;
  model: string;
  turn_count: number;
  total_tokens: number;
  archived: number;
}

function rowToMeta(r: Row): SessionMetadata {
  return {
    sessionId: r.session_id,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    cwd: r.cwd,
    provider: r.provider,
    model: r.model,
    turnCount: r.turn_count,
    totalTokens: r.total_tokens,
    archived: r.archived !== 0,
  };
}

export class SessionsIndex {
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly bumpStmt: Database.Statement;
  private readonly archiveStmt: Database.Statement;
  private readonly mostRecentStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO sessions_index
        (session_id, started_at, updated_at, cwd, provider, model, turn_count, total_tokens, archived)
      VALUES (@session_id, @started_at, @updated_at, @cwd, @provider, @model, 0, 0, 0)
    `);
    this.getStmt = db.prepare(
      "SELECT * FROM sessions_index WHERE session_id = ?",
    );
    this.bumpStmt = db.prepare(`
      UPDATE sessions_index
      SET updated_at = @updated_at,
          turn_count = turn_count + @turn_delta,
          total_tokens = total_tokens + @token_delta
      WHERE session_id = @session_id
    `);
    this.archiveStmt = db.prepare(
      "UPDATE sessions_index SET archived = 1, updated_at = ? WHERE session_id = ?",
    );
    this.mostRecentStmt = db.prepare(`
      SELECT * FROM sessions_index
      WHERE cwd = @cwd AND archived = 0
      ORDER BY updated_at DESC
      LIMIT 1
    `);
  }

  create(input: CreateSessionInput): SessionMetadata {
    const ts = new Date().toISOString();
    this.insertStmt.run({
      session_id: input.sessionId,
      started_at: ts,
      updated_at: ts,
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
    });
    const row = this.getStmt.get(input.sessionId) as Row;
    return rowToMeta(row);
  }

  get(sessionId: string): SessionMetadata | null {
    const row = this.getStmt.get(sessionId) as Row | undefined;
    return row ? rowToMeta(row) : null;
  }

  bump(args: {
    sessionId: string;
    turnDelta: number;
    tokenDelta: number;
  }): void {
    this.bumpStmt.run({
      session_id: args.sessionId,
      updated_at: new Date().toISOString(),
      turn_delta: args.turnDelta,
      token_delta: args.tokenDelta,
    });
  }

  archive(sessionId: string): void {
    this.archiveStmt.run(new Date().toISOString(), sessionId);
  }

  mostRecent(cwd: string): SessionMetadata | null {
    const row = this.mostRecentStmt.get({ cwd }) as Row | undefined;
    return row ? rowToMeta(row) : null;
  }

  list(filter: ListFilter = {}): SessionMetadata[] {
    const parts: string[] = ["SELECT * FROM sessions_index"];
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.cwd !== undefined) {
      where.push("cwd = @cwd");
      params["cwd"] = filter.cwd;
    }
    if (!filter.includeArchived) {
      where.push("archived = 0");
    }
    if (where.length > 0) {
      parts.push(`WHERE ${where.join(" AND ")}`);
    }
    parts.push("ORDER BY updated_at DESC");
    if (filter.limit !== undefined) {
      parts.push("LIMIT @limit");
      params["limit"] = filter.limit;
    }
    const stmt = this.db.prepare(parts.join(" "));
    const rows = stmt.all(params) as Row[];
    return rows.map(rowToMeta);
  }
}
