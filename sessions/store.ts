import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type AuditAction, AuditChain } from "../audit/chain.js";
import { connectDb } from "../db/connect.js";
import { logger } from "../logger.js";
import type { CanonicalMessage } from "../providers/types.js";
import { SessionsIndex } from "./index.js";
import { writeAssistantMessageSidecar } from "./message-sidecar.js";
import { recordsToMessages } from "./replay-records.js";
import {
  type CheckpointTurnInput,
  type RollbackResult,
  SessionRollbackService,
} from "./rollback-service.js";
import { truncateForPersistence } from "./truncate.js";
import type {
  AssistantMessagePayload,
  CreateSessionInput,
  ListFilter,
  RollbackTarget,
  SessionMetadata,
  SessionRecord,
  SessionRecordPayload,
  ToolCallPayload,
  ToolResultPayload,
  UserMessagePayload,
} from "./types.js";
import {
  type UsageFilter,
  type UsageGroupRow,
  UsageLedger,
  type UsageRecord,
  type UsageTotals,
} from "./usage-ledger.js";
import { readSessionFile, SessionWriter } from "./writer.js";

const STATE_DIR = join(homedir(), ".squad");
const DB_PATH = join(STATE_DIR, "audit.db");

export interface OpenSessionStoreOptions {
  stateDir?: string;
}

export interface ResumedSession {
  metadata: SessionMetadata;
  messages: CanonicalMessage[];
  records: SessionRecord[];
}

export interface SessionStore {
  create(input: CreateSessionInput): Promise<SessionMetadata>;
  resume(sessionId: string): Promise<ResumedSession>;
  resumeMostRecent(cwd: string): Promise<ResumedSession | null>;
  appendUserMessage(
    sessionId: string,
    content: string,
    turnId?: string,
  ): Promise<void>;
  appendAssistantMessage(
    sessionId: string,
    payload: AssistantMessagePayload,
    turnId?: string,
  ): Promise<void>;
  appendToolCall(
    sessionId: string,
    payload: ToolCallPayload,
    turnId?: string,
  ): Promise<void>;
  appendToolResult(
    sessionId: string,
    payload: ToolResultPayload,
    turnId?: string,
  ): Promise<void>;
  checkpointTurn(
    sessionId: string,
    input: CheckpointTurnInput,
  ): Promise<RollbackTarget>;
  listRollbackTargets(sessionId: string): Promise<RollbackTarget[]>;
  rollbackTurn(sessionId: string, turnId: string): Promise<RollbackResult>;
  recordPermissionDecision(
    sessionId: string,
    payload: { tool: string; callId: string; outcome: string },
  ): void;
  recordHookFire(
    sessionId: string,
    payload: {
      id: string;
      event: string;
      ok: boolean;
      status: string;
      elapsedMs: number;
    },
  ): void;
  recordUsage(record: UsageRecord): void;
  usageTotals(filter?: UsageFilter): UsageTotals;
  usageByDay(filter?: UsageFilter, limit?: number): UsageGroupRow[];
  usageBySession(filter?: UsageFilter, limit?: number): UsageGroupRow[];
  usageByModel(filter?: UsageFilter): UsageGroupRow[];
  bumpUsage(sessionId: string, turnDelta: number, tokenDelta: number): void;
  list(filter?: ListFilter): SessionMetadata[];
  read(sessionId: string): Promise<{
    metadata: SessionMetadata;
    records: SessionRecord[];
  }>;
  archive(sessionId: string): void;
  flush(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
  validateAuditChain(): { ok: boolean; brokenAtId?: number; reason?: string };
}

class SessionStoreImpl implements SessionStore {
  private readonly writers = new Map<string, SessionWriter>();
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly index: SessionsIndex,
    private readonly audit: AuditChain,
    private readonly usage: UsageLedger,
    private readonly sessionsDir: string,
    private readonly snapshotsDir: string,
  ) {}

  private sessionFilePath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  private async getOrOpenWriter(sessionId: string): Promise<SessionWriter> {
    let w = this.writers.get(sessionId);
    if (!w) {
      w = new SessionWriter(this.sessionFilePath(sessionId));
      await w.open();
      this.writers.set(sessionId, w);
    }
    return w;
  }

  private async writeRecord(
    sessionId: string,
    payload: SessionRecordPayload,
    turnId?: string,
  ): Promise<SessionRecord> {
    if (this.closed) throw new Error("session store is closed");
    const writer = await this.getOrOpenWriter(sessionId);
    const record: SessionRecord = {
      ts: new Date().toISOString(),
      sessionId,
      ...payload,
      ...(turnId && { turnId }),
    };
    await writer.append(record);
    return record;
  }

  private auditAppend(
    sessionId: string,
    action: AuditAction,
    payload: unknown,
  ): void {
    try {
      this.audit.append({ sessionId, action, payload });
    } catch (err: unknown) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "audit append failed",
      );
    }
  }

  async create(input: CreateSessionInput): Promise<SessionMetadata> {
    const meta = this.index.create(input);
    await this.writeRecord(input.sessionId, {
      type: "session_meta",
      payload: {
        cwd: input.cwd,
        provider: input.provider,
        model: input.model,
        ...(input.systemPrompt !== undefined && {
          systemPrompt: input.systemPrompt,
        }),
      },
    });
    this.auditAppend(input.sessionId, "session_started", {
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
    });
    return meta;
  }

  async resume(sessionId: string): Promise<ResumedSession> {
    const meta = this.index.get(sessionId);
    if (!meta) {
      throw new Error(`session ${sessionId} not found`);
    }
    const records = await readSessionFile(this.sessionFilePath(sessionId));
    const messages = recordsToMessages(records);
    this.auditAppend(sessionId, "session_resumed", {
      cwd: meta.cwd,
      messageCount: messages.length,
    });
    return { metadata: meta, messages, records };
  }

  async resumeMostRecent(cwd: string): Promise<ResumedSession | null> {
    const meta = this.index.mostRecent(cwd);
    if (!meta) return null;
    return await this.resume(meta.sessionId);
  }

  async appendUserMessage(
    sessionId: string,
    content: string,
    turnId?: string,
  ): Promise<void> {
    const payload: UserMessagePayload = { content };
    await this.writeRecord(
      sessionId,
      { type: "user_message", payload },
      turnId,
    );
    this.auditAppend(sessionId, "user_prompt", {
      contentChars: content.length,
    });
  }

  async appendAssistantMessage(
    sessionId: string,
    payload: AssistantMessagePayload,
    turnId?: string,
  ): Promise<void> {
    await this.writeRecord(
      sessionId,
      {
        type: "assistant_message",
        payload,
      },
      turnId,
    );
    await writeAssistantMessageSidecar({
      baseDir: this.sessionsDir,
      sessionId,
      content: payload.content,
    });
  }

  async appendToolCall(
    sessionId: string,
    payload: ToolCallPayload,
    turnId?: string,
  ): Promise<void> {
    await this.writeRecord(sessionId, { type: "tool_call", payload }, turnId);
    this.auditAppend(sessionId, "tool_call", {
      callId: payload.callId,
      toolName: payload.toolName,
    });
  }

  async appendToolResult(
    sessionId: string,
    payload: ToolResultPayload,
    turnId?: string,
  ): Promise<void> {
    // When the engine already offloaded the full content to an artifact, the
    // payload's `content` is the offload preview — small, complete, and no
    // longer the truncation target. Don't re-truncate; the sidecar already
    // captured the full output.
    let storedContent = payload.content;
    let storedTruncated = payload.contentTruncated;
    if (!payload.artifact) {
      const truncated = truncateForPersistence(payload.content);
      storedContent = truncated.text;
      storedTruncated = truncated.truncated;
    }
    const stored: ToolResultPayload = {
      ...payload,
      content: storedContent,
      contentTruncated: storedTruncated,
    };
    await this.writeRecord(
      sessionId,
      { type: "tool_result", payload: stored },
      turnId,
    );
    this.auditAppend(sessionId, "tool_result", {
      callId: payload.callId,
      toolName: payload.toolName,
      ok: payload.ok,
      reason: payload.reason,
      ...(payload.error !== undefined && { error: payload.error }),
      ...(payload.artifact && {
        artifactPath: payload.artifact.path,
        artifactBytes: payload.artifact.fullSizeBytes,
      }),
    });
  }

  async checkpointTurn(
    sessionId: string,
    input: CheckpointTurnInput,
  ): Promise<RollbackTarget> {
    return await this.rollbackService().checkpointTurn(sessionId, input);
  }

  async listRollbackTargets(sessionId: string): Promise<RollbackTarget[]> {
    return await this.rollbackService().listTargets(sessionId);
  }

  async rollbackTurn(
    sessionId: string,
    turnId: string,
  ): Promise<RollbackResult> {
    return await this.rollbackService().rollbackTurn(sessionId, turnId);
  }

  private rollbackService(): SessionRollbackService {
    return new SessionRollbackService({
      snapshotsDir: this.snapshotsDir,
      getMetadata: (sessionId) => this.index.get(sessionId),
      setProgress: (input) => this.index.setProgress(input),
      writeRecord: (sessionId, payload, turnId) =>
        this.writeRecord(sessionId, payload, turnId),
      readRecords: (sessionId) =>
        readSessionFile(this.sessionFilePath(sessionId)),
      flush: (sessionId) => this.flush(sessionId),
      getWriter: (sessionId) => this.getOrOpenWriter(sessionId),
      auditRollback: (sessionId, payload) =>
        this.auditAppend(sessionId, "session_rollback", payload),
    });
  }

  recordPermissionDecision(
    sessionId: string,
    payload: { tool: string; callId: string; outcome: string },
  ): void {
    this.auditAppend(sessionId, "permission_decision", payload);
  }

  recordHookFire(
    sessionId: string,
    payload: {
      id: string;
      event: string;
      ok: boolean;
      status: string;
      elapsedMs: number;
    },
  ): void {
    this.auditAppend(sessionId, "hook_fire", payload);
  }

  bumpUsage(sessionId: string, turnDelta: number, tokenDelta: number): void {
    this.index.bump({ sessionId, turnDelta, tokenDelta });
  }

  recordUsage(record: UsageRecord): void {
    try {
      this.usage.record(record);
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "usage ledger record failed",
      );
    }
  }

  usageTotals(filter: UsageFilter = {}): UsageTotals {
    return this.usage.totals(filter);
  }

  usageByDay(filter: UsageFilter = {}, limit?: number): UsageGroupRow[] {
    return this.usage.groupByDay(filter, limit);
  }

  usageBySession(filter: UsageFilter = {}, limit?: number): UsageGroupRow[] {
    return this.usage.groupBySession(filter, limit);
  }

  usageByModel(filter: UsageFilter = {}): UsageGroupRow[] {
    return this.usage.groupByModel(filter);
  }

  list(filter: ListFilter = {}): SessionMetadata[] {
    return this.index.list(filter);
  }

  async read(
    sessionId: string,
  ): Promise<{ metadata: SessionMetadata; records: SessionRecord[] }> {
    const meta = this.index.get(sessionId);
    if (!meta) throw new Error(`session ${sessionId} not found`);
    const records = await readSessionFile(this.sessionFilePath(sessionId));
    return { metadata: meta, records };
  }

  archive(sessionId: string): void {
    this.index.archive(sessionId);
    this.auditAppend(sessionId, "session_archived", {});
  }

  async flush(sessionId: string): Promise<void> {
    const writer = this.writers.get(sessionId);
    if (writer) await writer.flush();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: Error[] = [];
    for (const writer of this.writers.values()) {
      try {
        await writer.close();
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "writer close failed during shutdown",
        );
        failures.push(
          err instanceof Error
            ? err
            : new Error(`writer close failed: ${String(err)}`),
        );
      }
    }
    this.writers.clear();
    try {
      this.db.close();
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "sqlite close failed during shutdown",
      );
      failures.push(
        err instanceof Error
          ? err
          : new Error(`sqlite close failed: ${String(err)}`),
      );
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "session store shutdown failed");
    }
  }

  validateAuditChain(): { ok: boolean; brokenAtId?: number; reason?: string } {
    return this.audit.validate();
  }
}

export function openSessionStore(
  opts: OpenSessionStoreOptions = {},
): SessionStore {
  const stateDir = opts.stateDir ?? STATE_DIR;
  const sessionsDir = join(stateDir, "sessions");
  const db = connectDb({
    dbPath: opts.stateDir ? join(stateDir, "audit.db") : DB_PATH,
  });
  const index = new SessionsIndex(db);
  const audit = new AuditChain(db);
  const usage = new UsageLedger(db);
  return new SessionStoreImpl(
    db,
    index,
    audit,
    usage,
    sessionsDir,
    join(stateDir, "snapshots"),
  );
}

export { recordsToMessages } from "./replay-records.js";
export type {
  CheckpointTurnInput,
  RollbackResult,
} from "./rollback-service.js";
