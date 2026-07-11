import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit/chain.js";
import { connectDb } from "../src/db/connect.js";

describe("audit continuity chain", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "squad-audit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps one chain when independent stores append alternately", () => {
    const path = join(dir, "audit.db");
    const dbA = connectDb({ dbPath: path });
    const dbB = connectDb({ dbPath: path });
    try {
      const a = new AuditChain(dbA);
      const b = new AuditChain(dbB);
      a.append({ sessionId: "A", action: "session_started", payload: {} });
      b.append({ sessionId: "B", action: "session_started", payload: {} });
      a.append({ sessionId: "A", action: "user_prompt", payload: "one" });
      b.append({ sessionId: "B", action: "user_prompt", payload: "two" });

      expect(a.validate()).toEqual({ ok: true });
      expect(b.validate()).toEqual({ ok: true });
      expect(a.fetchAll()).toHaveLength(4);
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});
