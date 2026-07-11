import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionStore, type SessionStore } from "../src/sessions/store.js";

const stores: SessionStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.shutdown()));
});

describe("session rollback", () => {
  it("confirms JSONL, SQLite, and workspace state before returning", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "squad-rollback-state-"));
    const cwd = await mkdtemp(join(tmpdir(), "squad-rollback-work-"));
    const store = openSessionStore({ stateDir });
    stores.push(store);
    const sessionId = "rollback-session";
    await store.create({
      sessionId,
      cwd,
      provider: "test",
      model: "test-model",
    });

    await store.appendUserMessage(sessionId, "first request", "turn-1");
    await writeFile(join(cwd, "result.txt"), "first\n", "utf8");
    await store.appendAssistantMessage(
      sessionId,
      { content: "first response" },
      "turn-1",
    );
    await store.checkpointTurn(sessionId, {
      turnId: "turn-1",
      cwd,
      label: "first request",
      tokenDelta: 10,
    });

    await store.appendUserMessage(sessionId, "second request", "turn-2");
    await writeFile(join(cwd, "result.txt"), "second\n", "utf8");
    await writeFile(join(cwd, "later.txt"), "remove me\n", "utf8");
    await store.appendAssistantMessage(
      sessionId,
      { content: "second response" },
      "turn-2",
    );
    await store.checkpointTurn(sessionId, {
      turnId: "turn-2",
      cwd,
      label: "second request",
      tokenDelta: 20,
    });

    expect(
      (await store.listRollbackTargets(sessionId)).map((t) => t.turnId),
    ).toEqual(["turn-1", "turn-2"]);
    const result = await store.rollbackTurn(sessionId, "turn-1");

    expect(result.workspaceRestored).toBe(true);
    expect(result.metadata.turnCount).toBe(1);
    expect(result.metadata.totalTokens).toBe(10);
    const replay = result.messages.map((message) => message.content).join("\n");
    expect(replay).toContain("first response");
    expect(replay).not.toContain("second response");
    expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("first\n");
    await expect(
      readFile(join(cwd, "later.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await store.listRollbackTargets(sessionId)).map((t) => t.turnId),
    ).toEqual(["turn-1"]);

    await store.appendUserMessage(sessionId, "new branch", "turn-3");
    const persisted = await store.read(sessionId);
    expect(persisted.records.at(-1)).toMatchObject({
      type: "user_message",
      turnId: "turn-3",
    });
  });
});
