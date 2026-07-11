import { logger } from "../logger.js";
import type { CanonicalMessage } from "../providers/types.js";
import { recordsToMessages } from "./replay-records.js";
import { rollbackTargets, truncateAfterTurn } from "./rollback.js";
import {
  captureWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
} from "./snapshots.js";
import type {
  RollbackTarget,
  SessionMetadata,
  SessionRecord,
  SessionRecordPayload,
  TurnCheckpointPayload,
} from "./types.js";
import type { SessionWriter } from "./writer.js";

export interface CheckpointTurnInput {
  turnId: string;
  cwd: string;
  label: string;
  tokenDelta: number;
}

export interface RollbackResult {
  target: RollbackTarget;
  metadata: SessionMetadata;
  records: SessionRecord[];
  messages: CanonicalMessage[];
  workspaceRestored: boolean;
}

export interface RollbackServiceOptions {
  snapshotsDir: string;
  getMetadata: (sessionId: string) => SessionMetadata | null;
  setProgress: (input: {
    sessionId: string;
    turnCount: number;
    totalTokens: number;
  }) => void;
  writeRecord: (
    sessionId: string,
    payload: SessionRecordPayload,
    turnId?: string,
  ) => Promise<SessionRecord>;
  readRecords: (sessionId: string) => Promise<SessionRecord[]>;
  flush: (sessionId: string) => Promise<void>;
  getWriter: (sessionId: string) => Promise<SessionWriter>;
  auditRollback: (sessionId: string, payload: unknown) => void;
}

export class SessionRollbackService {
  constructor(private readonly opts: RollbackServiceOptions) {}

  async checkpointTurn(
    sessionId: string,
    input: CheckpointTurnInput,
  ): Promise<RollbackTarget> {
    const metadata = this.requireMetadata(sessionId);
    let workspaceSnapshot: string | undefined;
    try {
      workspaceSnapshot = await captureWorkspaceSnapshot({
        cwd: input.cwd,
        sessionId,
        turnId: input.turnId,
        baseDir: this.opts.snapshotsDir,
      });
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "workspace checkpoint failed; conversation checkpoint retained",
      );
    }
    const payload: TurnCheckpointPayload = {
      turnId: input.turnId,
      turnNumber: metadata.turnCount + 1,
      totalTokens: metadata.totalTokens + input.tokenDelta,
      label: turnLabel(input.label),
      ...(workspaceSnapshot && { workspaceSnapshot }),
    };
    const record = await this.opts.writeRecord(
      sessionId,
      { type: "turn_checkpoint", payload },
      input.turnId,
    );
    this.opts.setProgress({
      sessionId,
      turnCount: payload.turnNumber,
      totalTokens: payload.totalTokens,
    });
    return { ...payload, ts: record.ts };
  }

  async listTargets(sessionId: string): Promise<RollbackTarget[]> {
    await this.opts.flush(sessionId);
    return rollbackTargets(await this.opts.readRecords(sessionId));
  }

  async rollbackTurn(
    sessionId: string,
    turnId: string,
  ): Promise<RollbackResult> {
    const originalMetadata = this.requireMetadata(sessionId);
    await this.opts.flush(sessionId);
    const original = await this.opts.readRecords(sessionId);
    const truncated = truncateAfterTurn(original, turnId);
    const writer = await this.opts.getWriter(sessionId);
    const guardSnapshot = await this.captureGuard(
      sessionId,
      turnId,
      originalMetadata,
      truncated.target,
    );
    try {
      await writer.rewrite(truncated.records);
      this.opts.setProgress({
        sessionId,
        turnCount: truncated.target.turnNumber,
        totalTokens: truncated.target.totalTokens,
      });
      await this.restoreTarget(
        sessionId,
        originalMetadata.cwd,
        truncated.target,
      );
    } catch (err: unknown) {
      await this.recover(
        sessionId,
        writer,
        original,
        originalMetadata,
        guardSnapshot,
        err,
      );
    }
    this.opts.auditRollback(sessionId, {
      turnId,
      turnNumber: truncated.target.turnNumber,
      workspaceRestored: Boolean(truncated.target.workspaceSnapshot),
    });
    return {
      target: truncated.target,
      metadata: this.requireMetadata(sessionId),
      records: truncated.records,
      messages: recordsToMessages(truncated.records),
      workspaceRestored: Boolean(truncated.target.workspaceSnapshot),
    };
  }

  private requireMetadata(sessionId: string): SessionMetadata {
    const metadata = this.opts.getMetadata(sessionId);
    if (!metadata) throw new Error(`session ${sessionId} not found`);
    return metadata;
  }

  private async captureGuard(
    sessionId: string,
    turnId: string,
    metadata: SessionMetadata,
    target: RollbackTarget,
  ): Promise<string | undefined> {
    if (!target.workspaceSnapshot) return undefined;
    return await captureWorkspaceSnapshot({
      cwd: metadata.cwd,
      sessionId,
      turnId: `rollback-guard-${turnId}`,
      baseDir: this.opts.snapshotsDir,
      advanceRef: false,
    });
  }

  private async restoreTarget(
    sessionId: string,
    cwd: string,
    target: RollbackTarget,
  ): Promise<void> {
    if (!target.workspaceSnapshot) return;
    await restoreWorkspaceSnapshot({
      cwd,
      sessionId,
      snapshot: target.workspaceSnapshot,
      baseDir: this.opts.snapshotsDir,
    });
  }

  private async recover(
    sessionId: string,
    writer: SessionWriter,
    records: SessionRecord[],
    metadata: SessionMetadata,
    guardSnapshot: string | undefined,
    cause: unknown,
  ): Promise<never> {
    const errors: unknown[] = [cause];
    await writer.rewrite(records).catch((error: unknown) => errors.push(error));
    try {
      this.opts.setProgress({
        sessionId,
        turnCount: metadata.turnCount,
        totalTokens: metadata.totalTokens,
      });
    } catch (error: unknown) {
      errors.push(error);
    }
    if (guardSnapshot) {
      await restoreWorkspaceSnapshot({
        cwd: metadata.cwd,
        sessionId,
        snapshot: guardSnapshot,
        baseDir: this.opts.snapshotsDir,
      }).catch((error: unknown) => errors.push(error));
    }
    throw new AggregateError(errors, "session rollback failed");
  }
}

function turnLabel(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 160
    ? normalized
    : `${normalized.slice(0, 157)}...`;
}
