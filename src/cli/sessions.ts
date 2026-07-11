import { openSessionStore } from "../sessions/store.js";
import type { SessionRecord } from "../sessions/types.js";
import { sanitizeForTerminal } from "../terminal.js";

export type SessionsCliInput =
  | {
      kind: "list";
      cwd?: string;
      allCwds?: boolean;
      limit?: number;
      archived?: boolean;
    }
  | { kind: "show"; id: string };

export async function runSessionsCli(input: SessionsCliInput): Promise<void> {
  const store = openSessionStore();
  try {
    if (input.kind === "list") {
      const filter: Parameters<typeof store.list>[0] = {};
      if (!input.allCwds) {
        filter.cwd = input.cwd ?? process.cwd();
      }
      if (input.limit !== undefined) filter.limit = input.limit;
      if (input.archived) filter.includeArchived = true;
      const sessions = store.list(filter);
      if (sessions.length === 0) {
        process.stdout.write("(no sessions)\n");
        return;
      }
      const rootCwd = filter.cwd;
      if (rootCwd) {
        process.stdout.write(
          `sessions for cwd: ${sanitizeForTerminal(rootCwd)}\n`,
        );
      } else {
        process.stdout.write("sessions across all cwds\n");
      }
      process.stdout.write(
        "id (short)  updated_at            provider/model                turns  tokens\n",
      );
      process.stdout.write(
        "──────────  ────────────────────  ────────────────────────────  ─────  ──────\n",
      );
      for (const s of sessions) {
        const shortId = s.sessionId.slice(0, 8);
        const updated = s.updatedAt.replace("T", " ").slice(0, 19);
        const pm = sanitizeForTerminal(`${s.provider}/${s.model}`)
          .padEnd(28)
          .slice(0, 28);
        const turns = String(s.turnCount).padStart(5);
        const tokens = String(s.totalTokens).padStart(6);
        process.stdout.write(
          `${shortId}    ${updated}  ${pm}  ${turns}  ${tokens}\n`,
        );
      }
      return;
    }

    const { metadata, records } = await store.read(input.id);
    process.stdout.write(
      `session ${sanitizeForTerminal(metadata.sessionId)}\n`,
    );
    process.stdout.write(
      `started: ${sanitizeForTerminal(metadata.startedAt)}  updated: ${sanitizeForTerminal(metadata.updatedAt)}\n`,
    );
    process.stdout.write(`cwd: ${sanitizeForTerminal(metadata.cwd)}\n`);
    process.stdout.write(
      `provider/model: ${sanitizeForTerminal(metadata.provider)}/${sanitizeForTerminal(metadata.model)}\n`,
    );
    process.stdout.write(
      `turns: ${metadata.turnCount}  tokens: ${metadata.totalTokens}\n`,
    );
    if (metadata.archived) process.stdout.write("archived: yes\n");
    process.stdout.write("─".repeat(60));
    process.stdout.write("\n");
    for (const r of records) {
      renderRecord(r);
    }
  } finally {
    await store.shutdown();
  }
}

function renderRecord(r: SessionRecord): void {
  switch (r.type) {
    case "session_meta":
      return;
    case "user_message":
      process.stdout.write(`\n[user · ${r.ts}]\n`);
      process.stdout.write(`${sanitizeForTerminal(r.payload.content)}\n`);
      return;
    case "assistant_message":
      process.stdout.write(`\n[assistant · ${r.ts}]\n`);
      if (r.payload.content) {
        process.stdout.write(`${sanitizeForTerminal(r.payload.content)}\n`);
      }
      if (r.payload.toolCalls && r.payload.toolCalls.length > 0) {
        for (const tc of r.payload.toolCalls) {
          tc.name = sanitizeForTerminal(tc.name);
          tc.id = sanitizeForTerminal(tc.id);
          process.stdout.write(
            `  → tool_call ${tc.name} (${tc.id}): ${JSON.stringify(tc.args)}\n`,
          );
        }
      }
      return;
    case "tool_call":
      return;
    case "tool_result": {
      r.payload.toolName = sanitizeForTerminal(r.payload.toolName);
      r.payload.content = sanitizeForTerminal(r.payload.content);
      if (r.payload.error)
        r.payload.error = sanitizeForTerminal(r.payload.error);
      const tag = r.payload.ok ? "ok" : (r.payload.error ?? "failed");
      process.stdout.write(
        `\n[tool · ${r.payload.toolName} · ${tag}]\n${r.payload.content}\n`,
      );
      if (r.payload.contentTruncated) {
        process.stdout.write("(content truncated for persistence)\n");
      }
      return;
    }
  }
}
