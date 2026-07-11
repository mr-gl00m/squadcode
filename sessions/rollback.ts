import type { RollbackTarget, SessionRecord } from "./types.js";

export function rollbackTargets(
  records: readonly SessionRecord[],
): RollbackTarget[] {
  const targets: RollbackTarget[] = [];
  for (const record of records) {
    if (record.type !== "turn_checkpoint") continue;
    targets.push({ ...record.payload, ts: record.ts });
  }
  return targets;
}

export function truncateAfterTurn(
  records: readonly SessionRecord[],
  turnId: string,
): { records: SessionRecord[]; target: RollbackTarget } {
  const checkpointIndex = records.findIndex(
    (record) =>
      record.type === "turn_checkpoint" && record.payload.turnId === turnId,
  );
  if (checkpointIndex < 0) {
    throw new Error(`rollback checkpoint ${turnId} was not found`);
  }
  const checkpoint = records[checkpointIndex];
  if (checkpoint?.type !== "turn_checkpoint") {
    throw new Error(`rollback checkpoint ${turnId} is invalid`);
  }
  return {
    records: records.slice(0, checkpointIndex + 1),
    target: { ...checkpoint.payload, ts: checkpoint.ts },
  };
}
